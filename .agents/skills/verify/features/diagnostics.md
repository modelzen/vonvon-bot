# Status and diagnostics

The status and diagnostics page shows the Bridge version, the number of registered Agents and connected groups, the last read time, the data directory and the recent Bridge log, which it can follow live.

## Sub-features

- `diag-status` shows version, counts, last read and data directory.
- `diag-logs` shows the last 128 KB of the Bridge log and follows it every two seconds.
- `diag-recheck` re-reads status with `重新检查`.

## How to get to it (user POV)

- Choose `状态与诊断` in the sidebar.

## Driving it with verify.cjs

Preconditions:

- The doctor passes.

- **Open the page.** Run `node .agents/skills/verify/verify.cjs capture --click 状态与诊断`. `result.json` shows `after.title` equal to `状态与诊断`.
- **Linux proof.** `after.txt` contains `Bridge 版本` with `未知`, `已注册 Bot` with `0 个`, `数据目录` with `尚未确认`, and `Bridge 已停止，请先启动。` in the log area.
- **macOS proof.** With a connected Host, `Bridge 版本` shows `0.7.0`, `数据目录` shows a path inside the capture's isolated home, and the log area shows Host log lines.

## Gotchas

- On Linux the log area shows a raw IPC error, `Error invoking remote method 'bridge:machine'`. That is the blocked-Host state, not a new bug.
- Log following stops when you leave the page. Capture while the page is open.
