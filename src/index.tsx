// TODO: a small to-do list kept in a local SQLite database.
// - storage: `flux:sqlite` opened at a relative path, which resolves inside
//   the app's own per-app storage folder (on Android the app's private data
//   directory; on desktop the client's data tree under ~/.solidrt). Nothing is
//   sent anywhere: there is no network code in this app.
// - reads: createQuery re-runs whenever the todos table is written, so every
//   insert/update/delete below repaints the list with no manual refresh.
// - input: a focusable view with onTextInput (tap it to raise the keyboard),
//   Enter or the + button adds the item.
// - order: each task has a stored `position`; hold a task and drag it to
//   move it, and the new order is saved in one transaction.
// - tabs: Open and Completed; ticking a task off moves it to Completed and
//   stamps `completed_at`, unticking moves it back to the top of Open.
// - trash: × stamps `deleted_at` and the task shows only in the Trash tab,
//   from where it can be restored or deleted for good.
import {
  render,
  createSignal,
  createMemo,
  createEffect,
  createLongPress,
  getBoundingBox,
  createScroll,
  createPan,
  setFocus,
  startTextInput,
  focusedNode,
  safeArea,
  keyboardHeight,
  untrack,
  For,
  Show,
  Loading,
} from "@solidrt/core"
import type { KeyEvent } from "@solidrt/core"
import { Database, createQuery } from "@solidrt/core/data"

const BG = "#0f1115"
const CARD = "#181b22"
const LINE = "#262a33"
const TEXT = "#e8eaf0"
const MUTED = "#7d8494"
const ACCENT = "#4f8cff"
const GAP = 8

type Todo = { id: number; text: string; done: number; created_at: number; completed_at: number | null; deleted_at: number | null }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// "Today 17:39", "24 Sep 09:05", or "3 Mar 2025 09:05" in another year.
function formatTime(ms: number, now = new Date()): string {
  let d = new Date(ms)
  let time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  if (d.toDateString() === now.toDateString()) return `Today ${time}`
  let year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${time}`
}

// One connection for the app's lifetime. "rw+" creates the file on first run.
async function openDb(): Promise<Database> {
  let db = await Database.open("todo.db", "rw+")
  await db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id         INTEGER PRIMARY KEY,
      text       TEXT    NOT NULL,
      done       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      deleted_at   INTEGER
    );
  `)
  // Databases from before reordering have no position column: add it and
  // seed it from the old display order (open first, newest first).
  let columns = await db.query("PRAGMA table_info(todos)").all()
  if (!columns.some((c) => c.name === "position")) {
    await db.transaction([
      ["ALTER TABLE todos ADD COLUMN position INTEGER NOT NULL DEFAULT 0"],
      [`UPDATE todos SET position = (
          SELECT COUNT(*) FROM todos t
          WHERE (t.done, -t.created_at, -t.id) < (todos.done, -todos.created_at, -todos.id))`],
    ])
  }
  // Databases from before the Completed tab have no completion time; tasks
  // already done then keep an unknown one (NULL) and show none.
  if (!columns.some((c) => c.name === "completed_at")) {
    await db.exec("ALTER TABLE todos ADD COLUMN completed_at INTEGER")
  }
  if (!columns.some((c) => c.name === "deleted_at")) {
    await db.exec("ALTER TABLE todos ADD COLUMN deleted_at INTEGER")
  }
  return db
}

type NodeRef = { id: number }

function Field(props: { onSubmit: (text: string) => void }) {
  let node: NodeRef | undefined
  let [draft, setDraft] = createSignal("")
  let focused = () => node != null && focusedNode() === node.id

  let submit = () => {
    let text = draft().trim()
    if (text) props.onSubmit(text)
    setDraft("")
  }
  let onKeyDown = (e: KeyEvent) => {
    if (e.key === "Enter") submit()
    else if (e.key === "Backspace") setDraft((d) => Array.from(d).slice(0, -1).join(""))
    else if (e.key === "Escape") setFocus(null)
    else return
    e.stopPropagation()
  }

  return (
    <view flexDirection="row" gap={10} alignItems="center">
      <view
        ref={(n: NodeRef) => (node = n)}
        flexGrow={1}
        minWidth={0}
        height={48}
        paddingLeft={14}
        paddingRight={14}
        justifyContent="center"
        focusable
        cursor="text"
        onPointerDown={() => {
          if (!node) return
          setFocus(node.id)
          startTextInput()
        }}
        onTextInput={(e) => setDraft((d) => d + e.text)}
        onKeyDown={onKeyDown}
        textInputHints={{ capitalize: "sentences" }}
      >
        <d-rect color={CARD} radius={12} />
        <d-rect color={focused() ? ACCENT : LINE} radius={12} drawStyle="stroke" strokeWidth={1.5} />
        <text fontSize={17} color={draft() ? TEXT : MUTED} maxLines={1}>
          {draft() || "Add a task"}
          <Show when={focused()}>
            <span color={ACCENT}>|</span>
          </Show>
        </text>
      </view>
      <view width={48} height={48} alignItems="center" justifyContent="center" onPointerDown={submit}>
        <d-rect color={ACCENT} radius={12} />
        <text fontSize={26} fontWeight={600} color="#ffffff">+</text>
      </view>
    </view>
  )
}

type Drag = {
  onStart: () => void
  onMove: (dy: number) => void
  onEnd: () => void
}

// One task. Hold it (500 ms, finger or mouse) and drag to move it; `shift`
// slides it out of the way of another task being dragged, `hidden` blanks it
// while its floating copy (`lifted`) follows the pointer.
function Row(props: {
  todo: Todo
  onToggle: () => void
  onDelete: () => void
  /** Set in the Trash tab: the row shows a restore button, and × deletes for good. */
  onRestore?: () => void
  /** Absent on the first task, which is already at the top. */
  onMoveToTop?: () => void
  drag?: Drag
  nodeRef?: (n: NodeRef) => void
  shift?: number
  hidden?: boolean
  lifted?: boolean
}) {
  let done = () => props.todo.done === 1
  let lp = createLongPress({
    onLongPress: () => props.drag?.onStart(),
    onLongPressMove: (_dx, dy) => props.drag?.onMove(dy),
    onLongPressEnd: () => props.drag?.onEnd(),
  })
  return (
    <view
      ref={(n: NodeRef) => props.nodeRef?.(n)}
      flexDirection="row"
      alignItems="center"
      gap={12}
      paddingLeft={14}
      paddingRight={6}
      minHeight={52}
      y={props.shift ?? 0}
      opacity={props.hidden ? 0 : 1}
      scale={props.lifted ? 1.02 : 1}
      {...lp.handlers}
    >
      <d-rect color={props.lifted ? "#222734" : CARD} radius={12} />
      <Show when={props.lifted}>
        <d-rect color={ACCENT} radius={12} drawStyle="stroke" strokeWidth={1.5} />
      </Show>
      <view width={26} height={26} alignItems="center" justifyContent="center" onPointerUp={props.onToggle}>
        <d-rect
          color={done() ? ACCENT : MUTED}
          radius={7}
          drawStyle={done() ? "fill" : "stroke"}
          strokeWidth={2}
        />
        <Show when={done()}>
          <text fontSize={16} fontWeight={700} color="#ffffff">✓</text>
        </Show>
      </view>
      <view flexGrow={1} minWidth={0} paddingTop={10} paddingBottom={10} gap={2} onPointerUp={props.onToggle}>
        <text
          fontSize={17}
          color={done() ? MUTED : TEXT}
        >
          {props.todo.text}
        </text>
        <text fontSize={12} color={MUTED}>
          Created {formatTime(props.todo.created_at)}
          <Show when={done() && props.todo.completed_at != null}>
            {` · Completed ${formatTime(props.todo.completed_at!)}`}
          </Show>
          <Show when={props.todo.deleted_at != null}>
            {` · Deleted ${formatTime(props.todo.deleted_at!)}`}
          </Show>
        </text>
      </view>
      <Show when={props.onMoveToTop}>
        <view width={36} height={40} alignItems="center" justifyContent="center" onPointerUp={() => props.onMoveToTop?.()}>
          <text fontSize={18} color={MUTED}>↑</text>
        </view>
      </Show>
      <Show when={props.onRestore}>
        <view height={40} paddingLeft={8} paddingRight={8} alignItems="center" justifyContent="center" onPointerUp={() => props.onRestore?.()}>
          <text fontSize={15} color={ACCENT}>Restore</text>
        </view>
      </Show>
      <view width={40} height={40} alignItems="center" justifyContent="center" onPointerUp={props.onDelete}>
        <text fontSize={22} color={props.onRestore ? "#e5484d" : MUTED}>×</text>
      </view>
    </view>
  )
}

/** A segment of the tab bar; `weight` is its share of the width (default 2). */
function Tab(props: { label: string; active: boolean; onSelect: () => void; weight?: number }) {
  return (
    <view flexGrow={props.weight ?? 2} flexBasis={0} height={36} alignItems="center" justifyContent="center" onPointerDown={props.onSelect}>
      <Show when={props.active}>
        <d-rect color={ACCENT} radius={9} />
      </Show>
      <text fontSize={15} fontWeight={600} color={props.active ? "#ffffff" : MUTED}>{props.label}</text>
    </view>
  )
}

function TodoList(props: { db: Database }) {
  // The connection never changes for this component's life.
  let db = untrack(() => props.db)
  let rows = createQuery(db, "SELECT id, text, done, created_at, completed_at, deleted_at FROM todos ORDER BY position, id")
  let stored = createMemo(() => (rows() ?? []) as unknown as Todo[])
  // After a drop the new order shows at once from `localOrder`, until the
  // query re-reads the rows it just wrote; then the database is the truth again.
  let [localOrder, setLocalOrder] = createSignal<number[] | null>(null)
  createEffect(stored, () => {
    setLocalOrder(null)
  })
  let todos = createMemo(() => {
    let list = stored()
    let order = localOrder()
    if (!order) return list
    let rank = new Map(order.map((id, i) => [id, i]))
    return [...list].sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1))
  })
  let live = createMemo(() => todos().filter((t) => t.deleted_at == null))
  let trashed = createMemo(() =>
    todos()
      .filter((t) => t.deleted_at != null)
      .sort((a, b) => b.deleted_at! - a.deleted_at!),
  )
  let open = createMemo(() => live().filter((t) => t.done === 0).length)
  let doneCount = createMemo(() => live().length - open())

  // Three tabs: open tasks in their saved order, completed ones newest first,
  // and the trash (both kinds) most recently deleted first.
  type TabName = "open" | "done" | "trash"
  let [tab, setTab] = createSignal<TabName>("open")
  let visible = createMemo(() =>
    tab() === "open"
      ? live().filter((t) => t.done === 0)
      : tab() === "done"
        ? live()
            .filter((t) => t.done === 1)
            .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0))
        : trashed(),
  )

  // Writes go straight to SQLite; createQuery picks them up via onWrite.
  // A new task goes to the top.
  let add = (text: string) =>
    db.run(
      "INSERT INTO todos (text, created_at, position) VALUES (?, ?, (SELECT COALESCE(MIN(position), 0) - 1 FROM todos))",
      [text, Date.now()],
    )
  // Move a task to the top of the list and save the whole order.
  let moveToTop = (t: Todo) => {
    let ids = visible().map((x) => x.id).filter((id) => id !== t.id)
    ids.unshift(t.id)
    setLocalOrder(ids)
    saveOrder(ids)
  }
  let saveOrder = (ids: number[]) =>
    db.transaction(ids.map((id, i): [string, number[]] => ["UPDATE todos SET position = ? WHERE id = ?", [i, id]]))
  // Completing stamps the time; reopening clears it and puts the task back at
  // the top of the Open tab.
  let toggle = (t: Todo) =>
    t.done
      ? db.run(
          "UPDATE todos SET done = 0, completed_at = NULL, position = (SELECT COALESCE(MIN(position), 0) - 1 FROM todos) WHERE id = ?",
          [t.id],
        )
      : db.run("UPDATE todos SET done = 1, completed_at = ? WHERE id = ?", [Date.now(), t.id])
  // × outside the trash only moves a task there; restoring an open task puts
  // it back at the top of Open. Only the trash deletes rows for good.
  let trash = (t: Todo) => db.run("UPDATE todos SET deleted_at = ? WHERE id = ?", [Date.now(), t.id])
  let restore = (t: Todo) =>
    db.run(
      "UPDATE todos SET deleted_at = NULL, position = (SELECT COALESCE(MIN(position), 0) - 1 FROM todos) WHERE id = ?",
      [t.id],
    )
  let deleteForever = (t: Todo) => db.run("DELETE FROM todos WHERE id = ? AND deleted_at IS NOT NULL", [t.id])
  let trashCompleted = () =>
    db.run("UPDATE todos SET deleted_at = ? WHERE done = 1 AND deleted_at IS NULL", [Date.now()])
  // Emptying the trash cannot be undone, so it takes a second tap.
  let [confirmEmpty, setConfirmEmpty] = createSignal(false)
  let emptyTrash = () => {
    if (!confirmEmpty()) return setConfirmEmpty(true)
    setConfirmEmpty(false)
    db.run("DELETE FROM todos WHERE deleted_at IS NOT NULL")
  }

  // Scrolling: wheel on desktop, drag on touch. A tap that turned into a
  // scroll must not also toggle the row under the finger, hence `panned`.
  let viewport: NodeRef | undefined
  let content: NodeRef | undefined
  let scroll = createScroll(() => viewport, () => content)
  let panned = false
  let pan = createPan({
    axis: "vertical",
    onPanStart: () => (panned = true),
    onPanMove: (_dx, dy) => scroll.scrollBy({ y: -dy }),
    onPanEnd: () => queueMicrotask(() => (panned = false)),
  })
  let selectTab = (t: TabName) => {
    setTab(t)
    setConfirmEmpty(false)
    scroll.scrollTo({ y: 0 })
  }
  let tap = (fn: () => void) => () => {
    if (!panned && !dragging) fn()
  }

  // Reordering. At the long press the rows' boxes are measured once; while
  // the finger moves, the dragged task's floating copy follows it and the
  // tasks it passes slide by its height. The drop saves every position.
  let nodes = new Map<number, NodeRef>()
  let dragging = false
  type Slot = { id: number; top: number; height: number }
  let [drag, setDrag] = createSignal<{ from: number; dy: number; slots: Slot[] } | null>(null)
  // The index the dragged task lands at: how many other tasks have their
  // middle above the dragged task's middle.
  let target = createMemo(() => {
    let d = drag()
    if (!d) return -1
    let s = d.slots[d.from]!
    let center = s.top + s.height / 2 + d.dy
    return d.slots.filter((o, i) => i !== d.from && center > o.top + o.height / 2).length
  })
  let shiftOf = (id: number) => {
    let d = drag()
    if (!d) return 0
    let i = d.slots.findIndex((s) => s.id === id)
    let to = target()
    let pitch = d.slots[d.from]!.height + GAP
    if (i > d.from && i <= to) return -pitch
    if (i < d.from && i >= to) return pitch
    return 0
  }
  let dragFor = (t: Todo): Drag => ({
    onStart: () => {
      let slots: Slot[] = []
      for (let item of visible()) {
        let box = nodes.get(item.id) && getBoundingBox(nodes.get(item.id)!)
        if (!box) return
        slots.push({ id: item.id, top: box.y, height: box.height })
      }
      dragging = true
      setDrag({ from: slots.findIndex((s) => s.id === t.id), dy: 0, slots })
    },
    onMove: (dy) => setDrag((d) => d && { ...d, dy: d.dy + dy }),
    onEnd: () => {
      let d = drag()
      queueMicrotask(() => (dragging = false))
      if (!d) return
      let ids = d.slots.map((s) => s.id)
      let [moved] = ids.splice(d.from, 1)
      ids.splice(target(), 0, moved!)
      setDrag(null)
      if (target() === d.from) return
      setLocalOrder(ids)
      saveOrder(ids)
    },
  })
  let lifted = createMemo(() => {
    let d = drag()
    if (!d) return undefined
    let slot = d.slots[d.from]!
    let todo = visible().find((t) => t.id === slot.id)
    return todo && { todo, top: slot.top, dy: d.dy }
  })

  return (
    <view flexGrow={1} minHeight={0} gap={14}>
      <text fontSize={30} fontWeight={800} color={TEXT}>TODO</text>

      <view flexDirection="row" gap={6} padding={4}>
        <d-rect color={CARD} radius={12} />
        <Tab label={`Open (${open()})`} active={tab() === "open"} onSelect={() => selectTab("open")} />
        <Tab label={`Completed (${doneCount()})`} active={tab() === "done"} onSelect={() => selectTab("done")} />
        <Tab label={`Trash (${trashed().length})`} active={tab() === "trash"} onSelect={() => selectTab("trash")} weight={1} />
      </view>

      <Show when={tab() === "open"}>
        <Field onSubmit={add} />
      </Show>

      <view
        ref={(n: NodeRef) => (viewport = n)}
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        scrollY={scroll.offset().y}
        onWheel={(e) => scroll.scrollBy({ y: e.deltaY })}
        {...pan.handlers}
      >
        <view ref={(n: NodeRef) => (content = n)} position="relative" flexShrink={0} gap={GAP} paddingBottom={8}>
          <For each={visible()} keyed={(t) => t.id}>
            {(t) => (
              <Row
                todo={t()}
                nodeRef={(n) => nodes.set(t().id, n)}
                onToggle={tab() === "trash" ? () => {} : tap(() => toggle(t()))}
                onDelete={tap(() => (tab() === "trash" ? deleteForever(t()) : trash(t())))}
                onRestore={tab() === "trash" ? tap(() => restore(t())) : undefined}
                onMoveToTop={tab() !== "open" || visible()[0]?.id === t().id ? undefined : tap(() => moveToTop(t()))}
                drag={tab() === "open" ? dragFor(t()) : undefined}
                shift={shiftOf(t().id)}
                hidden={lifted()?.todo.id === t().id}
              />
            )}
          </For>
          {/* Last child, so it paints above every row it passes over. */}
          <Show when={lifted()}>
            {(l) => (
              <view position="absolute" left={0} right={0} top={l().top} y={l().dy} pointerEvents="none">
                <Row todo={l().todo} onToggle={() => {}} onDelete={() => {}} lifted />
              </view>
            )}
          </Show>
          <Show when={visible().length === 0}>
            <view paddingTop={40} alignItems="center">
              <text fontSize={16} color={MUTED}>{tab() === "open" ? "Nothing to do." : tab() === "done" ? "Nothing completed yet." : "Trash is empty."}</text>
            </view>
          </Show>
        </view>
      </view>

      <Show when={tab() === "done" && doneCount() > 0}>
        <view alignSelf="center" paddingTop={6} paddingBottom={6} paddingLeft={14} paddingRight={14} onPointerDown={trashCompleted}>
          <text fontSize={15} color={ACCENT}>Move all completed to Trash</text>
        </view>
      </Show>
      <Show when={tab() === "trash" && trashed().length > 0}>
        <view alignSelf="center" paddingTop={6} paddingBottom={6} paddingLeft={14} paddingRight={14} onPointerDown={emptyTrash}>
          <text fontSize={15} color="#e5484d">{confirmEmpty() ? "Tap again to delete them for good" : "Empty Trash"}</text>
        </view>
      </Show>
    </view>
  )
}

function App() {
  let db = createMemo(() => openDb())
  return (
    <window
      title="TODO"
      paddingTop={safeArea().top + 20}
      paddingBottom={Math.max(safeArea().bottom, keyboardHeight()) + 16}
      paddingLeft={safeArea().left + 16}
      paddingRight={safeArea().right + 16}
      alignItems="center"
    >
      <d-rect color={BG} />
      <view width="100%" maxWidth={560} flexGrow={1} minHeight={0}>
        <Loading fallback={<text color={MUTED}>Opening database…</text>}>
          <TodoList db={db()} />
        </Loading>
      </view>
    </window>
  )
}

render(() => <App />)
