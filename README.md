# Longbox

An offline comic library and reader for Windows.

Longbox indexes folders of comic archives, groups them into series, and reads
them. Nothing leaves the machine: there is no account, no network calls, and no
telemetry.

## Layout

    packages/core     parsing, metadata, grouping, and query logic
    apps/desktop      the Electron app (main process, preload, React renderer)

`@longbox/core` is platform-neutral by rule -- it touches no filesystem, network,
or DOM. Anything platform-specific is injected, so a second front-end can reuse
it unchanged. The desktop app consumes it as TypeScript source rather than as a
built package, so there is no build step to run first and no stale `dist` to
drift out of sync.

## Supported files

`.cbz` / `.zip`, `.cbr` / `.rar`, and `.cbt` / `.tar`. Archives are sniffed by
content, so a `.cbz` that is really a RAR still opens. Metadata comes from
`ComicInfo.xml` where present, and is otherwise inferred from the filename.

## Running it

    npm install
    npm run dev

## Building

    npm run build       compile main, preload, and renderer
    npm run dist:dir    packaged app, unpacked -- release/win-unpacked/Longbox.exe
    npm run dist        NSIS installer -- release/Longbox Setup <version>.exe

Build output lands in `release/` and is deliberately untracked; the unpacked app
is over 200 MB. Attach installers to a GitHub release rather than committing
them.

## Checks

    npm test            unit tests for the core package
    npm run typecheck   whole-workspace TypeScript check

There is also a smoke check for the archive layer, meant to be pointed at real
files, since archive bugs only ever show up on comics made by tools we do not
control:

    node --experimental-strip-types packages/core/src/archive/smoke.ts <file>...
