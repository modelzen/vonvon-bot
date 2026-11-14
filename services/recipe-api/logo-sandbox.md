# Linux Logo decoder artifact

Linux decoding requires the distribution's trusted `/usr/bin/bwrap` and a separate decoder artifact. There is no fallback to a same-UID unsandboxed decoder. `LOGO_DECODER_ROOT` is trusted deployment configuration, never a request or creator field. It must be an absolute canonical path with no dependency symlink escaping the artifact, and modules/dependencies must not be group/world writable. The artifact contains Sharp 0.35.5 and its flat npm dependency closure, plus exactly the three decoder source modules used by the launcher. Do not point it at the API or broker source/dependency tree.

On the target Linux architecture, from the immutable deployment source:

```sh
node services/recipe-api/scripts/package-logo-decoder.mjs /opt/vonvon-logo-decoder-VERSION
LOGO_DECODER_ROOT=/opt/vonvon-logo-decoder-VERSION node services/recipe-api/scripts/probe-logo-sandbox.mjs
LOGO_DECODER_ROOT=/opt/vonvon-logo-decoder-VERSION node --test services/recipe-api/test/logo.test.mjs services/recipe-api/test/logo-sandbox.test.mjs
```

The packaging command requires a new directory and produces its own package-lock.json. Preserve that lockfile and artifact digest with deployment evidence; build on the target OS/architecture with npm's optional native packages enabled. npm install uses `--ignore-scripts`. No API/broker configuration is copied. Install the trusted system RPM separately through the operator's distribution workflow. Launch-probe and logo tests must pass as the real service user, inside the real service security policy, before public routing. Namespace denial or missing native libraries is a failed gate, never permission to remove sandbox options.

The launcher makes new user, PID, network, IPC, UTS and cgroup namespaces; drops all capabilities; starts a new session; and binds lifetime to its parent. Only `/usr`, the distribution's `/lib` and `/lib64` layout, dynamic linker cache, the exact Node binary, three decoder modules, and the dedicated node_modules closure are mounted read-only. `/proc` is private to the new PID namespace and read-only. `/dev` exposes only null. `/tmp` and the root are read-only. Broker source, home, `/etc` configuration, credentials and host process namespace are absent. The new network namespace cannot connect to the host loopback listener. Environment contains only the three worker tuning variables. Input and result remain stdin/stdout; the caller cannot choose a command, worker, path, URL or launch option.

The parent retains its two-worker admission cap, 2 MiB ingress and 128 KiB stdout ceilings, five-second wall timer, CPU four-second hard limit, 1.5 GiB address space, 384 MiB data and zero core limits. bubblewrap's PID namespace and die-with-parent bind decoder descendants to the killed supervisor. Real deployment acceptance must also verify termination/reaping and subsequent admission recovery under that profile. macOS keeps the existing bounded development child and does not establish production credential isolation.

`probe-logo-sandbox.mjs` creates only fake parent credentials and a private cloned test artifact. It replaces the test clone's fixed worker with a probe, then uses the production launcher unchanged. It checks credential-file access, the parent proc environment path, inherited environment, host loopback and writes to root/system/artifact/tmp paths. It never reads real secrets. It leaves its unique temporary fixture directory for inspection.
