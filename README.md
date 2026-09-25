# SolidTodo

A small to-do list app built with [SolidRT](https://github.com/wellawaretech/solidrt). It runs as a desktop window and as an Android app.

- Tasks live in a local SQLite database (`todo.db`) in the app's own private storage folder. The app has no network code.
- Add and tick off tasks; Open and Completed tabs, with creation and completion times. Deleting moves a task to the Trash tab, where it can be restored or deleted for good.
- Each task shows when it was created.

## Run on the desktop

```sh
bun install
bun run dev
```

## Build for Android

```sh
bun add -d @solidrt/android-arm64-v8a
bun run apk
adb install -r dist/todo.apk
```

`bun run apk` packs the app with `srt pack --apk` and then runs `tools/private-apk.ts`, which turns off `allowBackup` and `debuggable` in the APK's manifest so the database can't be copied off the phone by Android backup or over USB.

The APK is signed with SolidRT's shared development key: fine for your own devices, not for distribution.
