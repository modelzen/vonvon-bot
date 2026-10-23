"""Manual native probe, no login or paid model calls.

From repo root: T=$(mktemp -d); python3 packages/daemon/scripts/probe-codex-linux.py "$T"
Optional second argument: Codex executable (npm, pnpm, or bun installation).
Keeps evidence under T; caller owns cleanup. Never reads the real CODEX_HOME.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

review_only = '--review-only' in sys.argv
arguments = [arg for arg in sys.argv[1:] if arg != '--review-only']
ROOT = Path(arguments[0]).resolve()
BIN = str(Path(arguments[1] if len(arguments) > 1 else shutil.which("codex")).absolute())
REPO = Path(__file__).resolve().parents[3]
ROOT.mkdir(exist_ok=True)
for part in ["home", "codex", "ws", "outside"]:
    (ROOT / part).mkdir(exist_ok=True)
(ROOT / "outside" / "secret").write_text("outside-marker")
(ROOT / "ws" / "inside").write_text("inside-marker")
command = "echo hi"
requests = 0


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        global requests
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        requests += 1
        output = next((x for x in reversed(body.get("input", []))
                       if x.get("type") == "function_call_output"), None)
        if output:
            item = {"type": "message", "role": "assistant", "id": f"m{requests}",
                    "content": [{"type": "output_text", "text": json.dumps(output["output"])}]}
        else:
            names = [x.get("name") for x in body.get("tools", [])]
            name = "exec_command" if "exec_command" in names else "shell_command"
            args = {"cmd" if name == "exec_command" else "command": command}
            item = {"type": "function_call", "id": f"fc{requests}",
                    "call_id": f"call{requests}", "name": name, "arguments": json.dumps(args)}
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for event in [
            {"type": "response.created", "response": {"id": f"r{requests}"}},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": {"id": f"r{requests}",
             "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
                       "input_tokens_details": None, "output_tokens_details": None}}},
        ]:
            self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())
        self.wfile.flush()


# Bundle the actual production policy; probes never maintain a second policy implementation.
helper = ROOT / "profile.ts"
helper.write_text(
    f'import {{codexFilesystem, codexInstallRoot}} from {json.dumps(str(REPO / "packages/daemon/src/agent/codex-appserver/workspace-policy.ts"))};\n'
    'const [bin, cwd, mode, network] = process.argv.slice(2);\n'
    'const installRoot = codexInstallRoot(bin);\nconsole.log(JSON.stringify({installRoot, filesystem:codexFilesystem([{path:cwd,access:mode === "qa" ? "read" : "write"}], mode, installRoot, process.platform, network === "1")}));\n')
subprocess.run([str(REPO / "node_modules/.bin/esbuild"), str(helper), "--bundle", "--platform=node",
                "--format=esm", f"--outfile={ROOT / 'profile.mjs'}"], check=True, capture_output=True)
server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
threading.Thread(target=server.serve_forever, daemon=True).start()
(ROOT / "codex/config.toml").write_text(
    'model_provider="fake"\nmodel="gpt-5"\n[model_providers.fake]\nname="fake"\n'
    f'base_url="http://127.0.0.1:{server.server_port}/v1"\nwire_api="responses"\nenv_key="FAKE_KEY"\n')
env = {**os.environ, "HOME": str(ROOT / "home"), "CODEX_HOME": str(ROOT / "codex"), "FAKE_KEY": "x"}


def turn(label, cmd, mode="write", network=False, workspace="ws", override=None, executable=BIN):
    global command
    command = cmd
    cwd = ROOT / workspace
    cwd.mkdir(exist_ok=True)
    profile = json.loads(subprocess.check_output([
        "node", str(ROOT / "profile.mjs"), executable, str(cwd), mode, str(int(network))], env=env))
    filesystem = profile["filesystem"]
    if override:
        filesystem[str(cwd)].update(override)
    proc = subprocess.Popen([executable, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env)
    pending, completed, observations = {}, threading.Event(), []
    sequence = 0

    def send(value):
        proc.stdin.write(json.dumps(value) + "\n")
        proc.stdin.flush()

    def read():
        for line in proc.stdout:
            msg = json.loads(line)
            if "id" in msg and "method" in msg:
                send({"id": msg["id"], "error": {"code": -32601, "message": "denied"}})
            elif "id" in msg:
                slot = pending[msg["id"]]
                slot[1] = msg
                slot[0].set()
            else:
                method = msg.get("method")
                if method == "item/completed":
                    item = msg.get("params", {}).get("item", {})
                    if item.get("type") in ["commandExecution", "agentMessage"]:
                        observations.append(item)
                if method == "turn/completed":
                    completed.set()

    def request(method, params):
        nonlocal sequence
        sequence += 1
        slot = [threading.Event(), None]
        pending[sequence] = slot
        send({"id": sequence, "method": method, "params": params})
        if not slot[0].wait(45):
            raise TimeoutError(method)
        return slot[1]

    threading.Thread(target=read, daemon=True).start()
    try:
        request("initialize", {"clientInfo": {"name": "s31e-probe", "version": "0"},
                               "capabilities": {"experimentalApi": True}})
        send({"method": "initialized"})
        started = request("thread/start", {
            "cwd": str(cwd), "runtimeWorkspaceRoots": [str(cwd)], "approvalPolicy": "never",
            "config": {"default_permissions": "feishu", "projects": {str(cwd): {"trust_level": "trusted"}},
                       "permissions": {"feishu": {"filesystem": filesystem, "network": {"enabled": network}}}},
        })
        if "result" in started:
            request("turn/start", {"threadId": started["result"]["thread"]["id"],
                    "input": [{"type": "text", "text": "run it", "text_elements": []}]})
            if not completed.wait(60):
                raise TimeoutError("turn/completed")
        result = {"label": label, "installRoot": profile["installRoot"], "start": started.get("error") or started["result"]["sandbox"],
                  "items": observations}
        print(json.dumps(result).replace(str(ROOT), "<T>"), flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


try:
    print("G " + subprocess.check_output([BIN, "--version"], env=env, text=True).strip(), flush=True)
    if not review_only:
        turn("A", f"echo hi; cat inside; cat {ROOT}/outside/secret", "qa")
        protected = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json',
                     '.claude/skills', '.claude/commands', '.claude/agents', '.codex', '.agents/skills']
        turn("B", "echo hi", override={p: "read" for p in protected})
        (ROOT / "ws/.claude").mkdir(exist_ok=True)
        (ROOT / "ws/.claude/settings.json").write_text("{}")
        turn("C", "echo x >> .claude/settings.json; touch .mcp.json")
        turn("D", "mkdir -p .codex/rules; touch .codex/rules/x", workspace="deny",
             override={p: "deny" for p in protected})
        for mode in ["qa", "write"]:
            for network in [False, True]:
                turn(f"E {mode} {network}", 'curl -sS --max-time 10 -o /dev/null -w "%{http_code}" https://example.com', mode, network)
        turn("F2 create", "mkdir -p .codex/rules; printf 'prefix_rule(pattern=[\"cat\"], decision=\"allow\")\\n' > .codex/rules/x.rules", workspace="rules")
        turn("F3 create", 'mkdir -p .codex; printf \'sandbox_mode = "danger-full-access"\\n\' > .codex/config.toml', workspace="config")
        # New app-server process for each read; existing files are not injected by the harness.
        for ws in ["rules", "config"]:
            for mode in ["qa", "write"]:
                turn(f"{ws} fresh {mode}", f"cat {ROOT}/outside/secret; touch {ROOT}/outside/x", mode, workspace=ws)
        turn("scaffold parent", "touch ../outside-test; echo $?", workspace="scaffold")
        print("scaffold file persisted on host: " + str((ROOT / "outside-test").exists()), flush=True)

    # Review 1: use existing native metadata with the same production read entries.
    for workspace, path, content in [
        ("existing-codex", ".codex/config.toml", 'sandbox_mode = "read-only"\n'),
        ("existing-agents", ".agents/skills/x/SKILL.md", "---\nname: x\ndescription: fixture\n---\nfixture\n"),
    ]:
        target = ROOT / workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        (ROOT / workspace / "inside").write_text("inside-marker")
        for mode in ["qa", "write"]:
            turn(f"existing {path} {mode}", "echo hi; cat inside", mode, workspace=workspace)

    # Review 7: copy the standalone runtime into the fake HOME, forcing file-only admission.
    native = Path(BIN).resolve()
    if native.suffix == ".js":
        for parent in native.parents:
            package = parent / "package.json"
            if package.is_file() and json.loads(package.read_text()).get("name") == "@openai/codex":
                native = next(parent.glob("node_modules/@openai/codex-*/vendor/*/bin/codex"))
                break
    standalone = ROOT / "home/codex"
    shutil.copy2(native, standalone)
    (ROOT / "home/guard-secret").write_text("guard-secret-marker")
    for mode in ["qa", "write"]:
        turn(f"file fallback {mode}", f"echo hi; cat inside; cat {ROOT}/home/guard-secret", mode,
             executable=str(standalone))

finally:
    server.shutdown()
    server.server_close()
