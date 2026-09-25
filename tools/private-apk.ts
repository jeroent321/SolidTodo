// Harden an APK written by `srt pack --apk` so the TODO data stays on the phone.
//
// solidRT 0.0.62's prebuilt Android runner declares, on <application>:
//   android:allowBackup="true"  - Android Auto Backup may copy the app's files
//                                 (todo.db included) to the user's Google
//                                 Drive backup and to a new phone.
//   android:debuggable="true"   - `adb shell run-as <appId>` can read the
//                                 app's private files over USB.
// Both are plain booleans in the compiled manifest, so they are flipped to
// false in place, and the APK is re-zipped and re-signed with the same
// development key `srt pack` uses (via the CLI's own zip/sign helpers).
//
// Usage (from todo/): bun tools/private-apk.ts [dist/todo.apk]
import { readFileSync, writeFileSync } from "node:fs"
import { inflateRawSync, deflateRawSync } from "node:zlib"
import { parseZip, writeZip, crc32 } from "@solidrt/cli/src/pack/android/zip"
import { signApk } from "@solidrt/cli/src/pack/android/sign"

const FLAGS = ["allowBackup", "debuggable"]
const START_ELEMENT = 0x0102
const TYPE_BOOLEAN = 0x12

// Strings of the manifest's string pool (the chunk right after the 8-byte file header).
function pool(axml: Buffer): string[] {
  let off = 8
  let count = axml.readUInt32LE(off + 8)
  let utf8 = (axml.readUInt32LE(off + 16) & 0x100) !== 0
  let start = axml.readUInt32LE(off + 20)
  let out: string[] = []
  for (let i = 0; i < count; i++) {
    let p = off + start + axml.readUInt32LE(off + 28 + i * 4)
    if (utf8) {
      p += axml[p]! & 0x80 ? 2 : 1
      let n = axml[p]!
      p++
      if (n & 0x80) n = ((n & 0x7f) << 8) | axml[p++]!
      out.push(axml.toString("utf8", p, p + n))
    } else {
      let n = axml.readUInt16LE(p)
      out.push(axml.toString("utf16le", p + 2, p + 2 + n * 2))
    }
  }
  return out
}

function harden(axml: Buffer): string[] {
  let strings = pool(axml)
  let changed: string[] = []
  let p = 8 + axml.readUInt32LE(8 + 4)
  while (p < axml.length) {
    let type = axml.readUInt16LE(p)
    let size = axml.readUInt32LE(p + 4)
    if (type === START_ELEMENT && strings[axml.readUInt32LE(p + 20)] === "application") {
      let attrStart = axml.readUInt16LE(p + 24)
      let attrSize = axml.readUInt16LE(p + 26)
      let attrCount = axml.readUInt16LE(p + 28)
      for (let i = 0; i < attrCount; i++) {
        let a = p + 16 + attrStart + i * attrSize
        let name = strings[axml.readUInt32LE(a + 4)]!
        if (!FLAGS.includes(name)) continue
        if (axml[a + 15] !== TYPE_BOOLEAN) throw new Error(`${name} is not a boolean literal`)
        if (axml.readUInt32LE(a + 16) !== 0) {
          axml.writeUInt32LE(0, a + 16)
          changed.push(name)
        }
      }
      return changed
    }
    p += size
  }
  throw new Error("no <application> element in the manifest")
}

let path = process.argv[2] ?? "dist/todo.apk"
let entries = parseZip(readFileSync(path))
let manifest = entries.find((e) => e.name.toString("latin1") === "AndroidManifest.xml")
if (!manifest) throw new Error(`${path} has no AndroidManifest.xml`)
let axml = manifest.method === 0 ? Buffer.from(manifest.data) : inflateRawSync(manifest.data)
let changed = harden(axml)
manifest.data = manifest.method === 0 ? axml : deflateRawSync(axml, { level: 9 })
manifest.crc = crc32(axml)
manifest.usize = axml.length
let { local, cd } = writeZip(entries)
writeFileSync(path, signApk(local, cd, entries.length))
console.log(changed.length ? `set ${changed.join(", ")} to false in ${path}` : `${path} was already hardened`)
