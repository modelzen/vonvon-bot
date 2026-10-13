/*
 * vonvon-holder: the POSIX retaining parent for one provider process.
 * Contract: docs/providers.md, "Process host". Protocol version 1.
 *
 * Slots: 0 commands in, 1 receipts out, 2 log, 3/4/5 provider stdin/stdout/stderr.
 *
 * Step names written in `E <step> <errno>` frames and `launch-failed` receipts:
 *   sigset  reset SIGTERM/INT/HUP/PIPE/CHLD to SIG_DFL and install an empty mask
 *   setsid  become session and group leader
 *   go      read error on the go pipe (cancellation writes `C`, not `E`)
 *   chdir   enter the requested cwd
 *   dup2    slots 3, 4, 5 onto 0, 1, 2
 *   close   close_range, or the close loop over every fd >= 3
 *   exec    command resolution and execve
 *
 * Exit codes: 0 after `exit` or a proven-empty group, 10 never-launched,
 * 11 launch-failed, 1 internal error.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#else
#include <paths.h>
#endif

#define PROTOCOL_VERSION 1
#define TERM_WAIT_MS 1500
#define PROBE_INTERVAL_MS 100
#define EXIT_FLUSH_MS 2000
#define RECEIPT_MAX 96
#define QUEUE_CAP 256
#define FIELD_MAX (1u << 20)
#define COUNT_MAX (1u << 16)
#define NONCE_MAX 32

enum { SLOT_CMD = 0, SLOT_RECEIPT = 1, SLOT_LOG = 2, SLOT_IN = 3, SLOT_OUT = 4, SLOT_ERR = 5 };
enum { CODE_OK = 0, CODE_INTERNAL = 1, CODE_NEVER_LAUNCHED = 10, CODE_LAUNCH_FAILED = 11 };

enum phase { PH_IDLE, PH_FORKED, PH_CREATED, PH_GO_SENT, PH_RUNNING, PH_NO_PROVIDER };
enum identity { ID_NONE, ID_RETAINED, ID_REAPED };
enum dying { DY_NO, DY_TERM_SENT, DY_KILL_SENT, DY_PROBING };
enum status_frame { SF_NONE, SF_C, SF_E };
enum cmd_mode { CM_LINE, CM_BYTES };
enum launch_step { LS_NONE, LS_FILE, LS_ARGC, LS_ARG, LS_ENVC, LS_ENV, LS_CWD };

struct launch {
  char nonce[NONCE_MAX + 1];
  char *file, *cwd, **argv, **envp;
  size_t argc, argi, envc, envi;
};

struct cmd_parser {
  char *buf;
  size_t len, cap, need;
  enum cmd_mode mode;
  enum launch_step step;
  struct launch launch;
};

struct status_parser {
  int fd;
  bool saw_s, in_line;
  enum status_frame frame;
  char line[64], step[16];
  size_t len;
  unsigned err;
};

struct receipt { char text[RECEIPT_MAX]; size_t len, written; bool keep; };
struct receipt_queue { struct receipt items[QUEUE_CAP]; size_t head, count; };

struct holder {
  enum phase phase;
  enum identity identity;
  bool created, latched, observed;
  pid_t pid;
  char nonce[NONCE_MAX + 1];
  int exit_code, exit_signal;
  int cmd_fd, receipt_fd, self_r, go_writer;
  struct cmd_parser cmd;
  struct status_parser status;
  struct receipt_queue out;
  enum dying dying;
  int64_t deadline_ms;
};

static int g_self_w = -1;

static const struct { int num; const char *name; } SIGNAL_NAMES[] = {
  { SIGHUP, "SIGHUP" }, { SIGINT, "SIGINT" }, { SIGQUIT, "SIGQUIT" }, { SIGILL, "SIGILL" },
  { SIGTRAP, "SIGTRAP" }, { SIGABRT, "SIGABRT" }, { SIGBUS, "SIGBUS" }, { SIGFPE, "SIGFPE" },
  { SIGKILL, "SIGKILL" }, { SIGUSR1, "SIGUSR1" }, { SIGSEGV, "SIGSEGV" }, { SIGUSR2, "SIGUSR2" },
  { SIGPIPE, "SIGPIPE" }, { SIGALRM, "SIGALRM" }, { SIGTERM, "SIGTERM" }, { SIGCHLD, "SIGCHLD" },
  { SIGCONT, "SIGCONT" }, { SIGSTOP, "SIGSTOP" }, { SIGTSTP, "SIGTSTP" }, { SIGTTIN, "SIGTTIN" },
  { SIGTTOU, "SIGTTOU" }, { SIGXCPU, "SIGXCPU" }, { SIGXFSZ, "SIGXFSZ" }, { SIGVTALRM, "SIGVTALRM" },
  { SIGPROF, "SIGPROF" }, { SIGSYS, "SIGSYS" },
};

static void signal_name(int sig, char *out, size_t size) {
  for (size_t i = 0; i < sizeof SIGNAL_NAMES / sizeof SIGNAL_NAMES[0]; i++) {
    if (SIGNAL_NAMES[i].num == sig) { snprintf(out, size, "%s", SIGNAL_NAMES[i].name); return; }
  }
  snprintf(out, size, "SIG%d", sig);
}

static int64_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void logmsg(const char *fmt, ...) {
  char line[256];
  int n = snprintf(line, sizeof line, "holder: ");
  va_list ap;
  va_start(ap, fmt);
  n += vsnprintf(line + n, sizeof line - (size_t)n, fmt, ap);
  va_end(ap);
  if (n > (int)sizeof line - 2) n = (int)sizeof line - 2;
  line[n++] = '\n';
  if (write(SLOT_LOG, line, (size_t)n) < 0) { /* the log is best effort */ }
}

static void set_flags(int fd, int fl_flags, bool cloexec) {
  int flags = fcntl(fd, F_GETFL);
  if (flags >= 0) fcntl(fd, F_SETFL, flags | fl_flags);
  if (cloexec) fcntl(fd, F_SETFD, FD_CLOEXEC);
}

static void on_sigchld(int sig) {
  (void)sig;
  int saved = errno;
  if (write(g_self_w, "c", 1) < 0) { /* a full self-pipe already wakes the loop */ }
  errno = saved;
}

/* ---- receipts ------------------------------------------------------------ */

static bool is_diagnostic(const char *text) {
  return strncmp(text, "hello ", 6) == 0 || strncmp(text, "not-ready ", 10) == 0;
}

static void queue_drop_diagnostic(struct receipt_queue *q) {
  for (size_t i = 0; i < q->count; i++) {
    size_t at = (q->head + i) % QUEUE_CAP;
    if (q->items[at].keep) continue;
    for (size_t j = i; j + 1 < q->count; j++) {
      q->items[(q->head + j) % QUEUE_CAP] = q->items[(q->head + j + 1) % QUEUE_CAP];
    }
    q->count--;
    return;
  }
  logmsg("receipt queue full of retained receipts; dropping the oldest");
  q->head = (q->head + 1) % QUEUE_CAP;
  q->count--;
}

static void emit(struct holder *h, const char *fmt, ...) {
  if (h->receipt_fd < 0) return;
  struct receipt r = { .len = 0, .written = 0, .keep = true };
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(r.text, sizeof r.text - 1, fmt, ap);
  va_end(ap);
  if (n < 0 || n >= (int)sizeof r.text - 1) { logmsg("receipt too long: %.20s", r.text); return; }
  r.text[n++] = '\n';
  r.len = (size_t)n;
  r.keep = !is_diagnostic(r.text);
  struct receipt_queue *q = &h->out;
  if (q->count == QUEUE_CAP) queue_drop_diagnostic(q);
  q->items[(q->head + q->count) % QUEUE_CAP] = r;
  q->count++;
}

/* Writes as much of the queue as the fd takes; a dead reader ends the receipt channel for good. */
static void flush_receipts(struct holder *h) {
  struct receipt_queue *q = &h->out;
  while (h->receipt_fd >= 0 && q->count > 0) {
    struct receipt *r = &q->items[q->head];
    ssize_t n = write(h->receipt_fd, r->text + r->written, r->len - r->written);
    if (n < 0) {
      if (errno == EAGAIN || errno == EINTR) return;
      logmsg("receipt channel closed: %s", strerror(errno));
      close(h->receipt_fd);
      h->receipt_fd = -1;
      q->count = 0;
      return;
    }
    r->written += (size_t)n;
    if (r->written == r->len) { q->head = (q->head + 1) % QUEUE_CAP; q->count--; }
  }
}

static _Noreturn void finish(struct holder *h, int code) {
  h->phase = PH_NO_PROVIDER;
  int64_t until = now_ms() + EXIT_FLUSH_MS;
  while (h->receipt_fd >= 0 && h->out.count > 0) {
    int64_t left = until - now_ms();
    if (left <= 0) break;
    struct pollfd p = { .fd = h->receipt_fd, .events = POLLOUT };
    if (poll(&p, 1, (int)left) <= 0) continue;
    flush_receipts(h);
  }
  _exit(code);
}

/* ---- child ---------------------------------------------------------------- */

static _Noreturn void child_fail(int status_w, const char *step, int err) {
  char frame[64];
  int n = snprintf(frame, sizeof frame, "E %s %d\n", step, err);
  if (write(status_w, frame, (size_t)n) < 0) { /* nothing left to report to */ }
  _exit(127);
}

static void child_close_others(int status_w) {
#if defined(__linux__) && defined(SYS_close_range)
  bool below = status_w <= 3 || syscall(SYS_close_range, 3u, (unsigned)status_w - 1u, 0u) == 0;
  if (below && syscall(SYS_close_range, (unsigned)status_w + 1u, ~0u, 0u) == 0) return;
  if (errno != ENOSYS && errno != EINVAL) child_fail(status_w, "close", errno);
#endif
  struct rlimit rl;
  long limit = getrlimit(RLIMIT_NOFILE, &rl) == 0 && rl.rlim_cur != RLIM_INFINITY ? (long)rl.rlim_cur : sysconf(_SC_OPEN_MAX);
  if (limit < 3) limit = 1024;
  for (long fd = 3; fd < limit; fd++) {
    if (fd != status_w) close((int)fd);
  }
}

static const char *env_path(char *const *envp) {
  for (; *envp; envp++) {
    if (strncmp(*envp, "PATH=", 5) == 0) return *envp + 5;
  }
  return NULL;
}

/* Node v22.12.0 libuv contract, except ENOEXEC: libc execvp retries through /bin/sh and this never does. */
static int exec_resolved(const char *file, char *const *argv, char *const *envp) {
  if (strchr(file, '/')) { execve(file, argv, envp); return errno; }
  const char *path = env_path(envp);
  char fallback[4096];
  if (!path) {
#ifdef __APPLE__
    snprintf(fallback, sizeof fallback, "%s", _PATH_DEFPATH);
#else
    if (confstr(_CS_PATH, fallback, sizeof fallback) == 0) snprintf(fallback, sizeof fallback, "/bin:/usr/bin");
#endif
    path = fallback;
  }
  int remembered = 0;
  for (const char *p = path; ; ) {
    const char *end = strchr(p, ':');
    size_t dirlen = end ? (size_t)(end - p) : strlen(p);
    char candidate[4096];
    int n = dirlen == 0 ? snprintf(candidate, sizeof candidate, "%s", file)
                        : snprintf(candidate, sizeof candidate, "%.*s/%s", (int)dirlen, p, file);
    if (n > 0 && n < (int)sizeof candidate) {
      execve(candidate, argv, envp);
      if (errno == EACCES) remembered = EACCES;
      else if (errno != ENOENT && errno != ENOTDIR) return errno;
    }
    if (!end) break;
    p = end + 1;
  }
  return remembered ? remembered : ENOENT;
}

static void child_setup(const struct launch *l, int go_r, int status_w) {
  const int reset[] = { SIGTERM, SIGINT, SIGHUP, SIGPIPE, SIGCHLD };
  for (size_t i = 0; i < sizeof reset / sizeof reset[0]; i++) {
    if (signal(reset[i], SIG_DFL) == SIG_ERR) child_fail(status_w, "sigset", errno);
  }
  sigset_t empty;
  sigemptyset(&empty);
  if (sigprocmask(SIG_SETMASK, &empty, NULL) != 0) child_fail(status_w, "sigset", errno);
  if (setsid() < 0) child_fail(status_w, "setsid", errno);
  if (write(status_w, "S", 1) != 1) _exit(127);

  char go[2];
  size_t total = 0;
  for (;;) {
    ssize_t n = read(go_r, go + (total < 2 ? total : 1), 1);
    if (n < 0) { if (errno == EINTR) continue; child_fail(status_w, "go", errno); }
    if (n == 0) break;
    total += (size_t)n;
  }
  close(go_r);
  if (total != 1 || go[0] != 'G') {
    if (write(status_w, "C", 1) < 0) { /* the parent observes the exit regardless */ }
    _exit(127);
  }

  if (l->cwd[0] != '\0' && chdir(l->cwd) != 0) child_fail(status_w, "chdir", errno);
  if (dup2(SLOT_IN, 0) < 0 || dup2(SLOT_OUT, 1) < 0 || dup2(SLOT_ERR, 2) < 0) child_fail(status_w, "dup2", errno);
  child_close_others(status_w);
  child_fail(status_w, "exec", exec_resolved(l->file, l->argv, l->envp));
}

/* ---- holder-side launch, signals, reap, probe ---------------------------- */

static void cancel(struct holder *h) {
  h->latched = true;
  if (h->go_writer >= 0) { close(h->go_writer); h->go_writer = -1; }
}

static int signal_group(struct holder *h, int sig) {
  return kill(-h->pid, sig) == 0 ? 0 : errno;
}

static void reap(struct holder *h) {
  siginfo_t si;
  memset(&si, 0, sizeof si);
  if (waitid(P_PID, h->pid, &si, WEXITED | WNOHANG) != 0 || si.si_pid != h->pid) {
    logmsg("reap after observation failed: %s", strerror(errno));
    finish(h, CODE_INTERNAL);
  }
  h->identity = ID_REAPED;
}

static void begin_probing(struct holder *h) {
  h->dying = DY_PROBING;
  h->deadline_ms = now_ms();
}

static void do_launch(struct holder *h, const struct launch *l) {
  if (h->latched) { emit(h, "refused launch %s cancelled", l->nonce); return; }
  if (h->created) { emit(h, "refused launch %s already-created", l->nonce); return; }
  h->created = true;
  snprintf(h->nonce, sizeof h->nonce, "%s", l->nonce);
  int go[2], status[2];
  if (pipe(go) != 0) { emit(h, "launch-failed %s %d", l->nonce, errno); finish(h, CODE_LAUNCH_FAILED); }
  if (pipe(status) != 0) { emit(h, "launch-failed %s %d", l->nonce, errno); finish(h, CODE_LAUNCH_FAILED); }
  fcntl(status[1], F_SETFD, FD_CLOEXEC);
  pid_t pid = fork();
  if (pid < 0) { emit(h, "launch-failed %s %d", l->nonce, errno); finish(h, CODE_LAUNCH_FAILED); }
  if (pid == 0) {
    close(go[1]);
    close(status[0]);
    child_setup(l, go[0], status[1]);
  }
  close(go[0]);
  close(status[1]);
  close(SLOT_IN);
  close(SLOT_OUT);
  close(SLOT_ERR);
  h->pid = pid;
  h->identity = ID_RETAINED;
  h->phase = PH_FORKED;
  h->go_writer = go[1];
  h->status.fd = status[0];
  set_flags(status[0], O_NONBLOCK, true);
  set_flags(go[1], 0, true);
}

static void on_go(struct holder *h, const char *nonce) {
  if (h->latched) { emit(h, "refused go %s cancelled", nonce); return; }
  if (h->phase == PH_GO_SENT || h->phase == PH_RUNNING) { emit(h, "refused go %s already-sent", nonce); return; }
  if (h->phase != PH_CREATED) { emit(h, "refused go %s not-launched", nonce); return; }
  if (write(h->go_writer, "G", 1) != 1) logmsg("go write failed: %s", strerror(errno));
  close(h->go_writer);
  h->go_writer = -1;
  h->phase = PH_GO_SENT;
}

static void on_rung(struct holder *h, const char *rung, int sig, const char *nonce) {
  if (h->identity == ID_REAPED) { emit(h, "refused %s %s reaped", rung, nonce); return; }
  if (h->identity == ID_NONE || h->phase < PH_GO_SENT) {
    emit(h, "refused %s %s not-launched", rung, nonce);
    cancel(h);
    return;
  }
  int err = signal_group(h, sig);
  if (sig == SIGTERM) {
    int cont = signal_group(h, SIGCONT);
    if (cont) logmsg("SIGCONT after SIGTERM: %s", strerror(cont));
  }
  if (err) emit(h, "refused %s %s %d", rung, nonce, err);
  else emit(h, "sent %s %s", rung, nonce);
}

static void on_reap(struct holder *h, const char *nonce) {
  if (h->identity == ID_RETAINED && h->observed) reap(h);
  if (h->identity == ID_REAPED) emit(h, "reaped %s", nonce);
  else emit(h, "not-ready %s", nonce);
}

static void on_probe(struct holder *h, const char *nonce) {
  if (h->identity == ID_NONE) { emit(h, "refused probe %s not-launched", nonce); return; }
  int err = signal_group(h, 0);
  if (err == 0) emit(h, "live %s", nonce);
  else if (err == ESRCH) emit(h, "empty %s", nonce);
  else emit(h, "probe-unknown %s %d", nonce, err);
}

static void on_abandon(struct holder *h) {
  cancel(h);
  if (h->identity == ID_NONE) finish(h, CODE_NEVER_LAUNCHED);
}

/* ---- observation ---------------------------------------------------------- */

enum status_read { SR_DATA, SR_EOF, SR_WOULDBLOCK };
static enum status_read read_status(struct holder *h);

static void on_observed(struct holder *h) {
  if (h->status.frame == SF_C) {
    reap(h);
    emit(h, "cancelled %s", h->nonce);
    finish(h, CODE_NEVER_LAUNCHED);
  }
  if (h->status.frame == SF_E) {
    reap(h);
    emit(h, "launch-failed %s %s %u", h->nonce, h->status.step, h->status.err);
    finish(h, CODE_LAUNCH_FAILED);
  }
  if (h->exit_signal) {
    char name[16];
    signal_name(h->exit_signal, name, sizeof name);
    emit(h, "provider-exit - %s", name);
  } else {
    emit(h, "provider-exit %d -", h->exit_code);
  }
  if (h->cmd_fd < 0 && h->dying != DY_TERM_SENT) { reap(h); begin_probing(h); }
}

static void observe(struct holder *h) {
  if (h->identity != ID_RETAINED || h->observed) return;
  siginfo_t si;
  memset(&si, 0, sizeof si);
  if (waitid(P_PID, h->pid, &si, WEXITED | WNOHANG | WNOWAIT) != 0 || si.si_pid != h->pid) return;
  h->observed = true;
  if (si.si_code == CLD_EXITED) { h->exit_code = si.si_status; h->exit_signal = 0; }
  else { h->exit_code = 0; h->exit_signal = si.si_status; }
  while (h->status.fd >= 0 && read_status(h) == SR_DATA) { /* the dead child's last frame precedes its exit */ }
  on_observed(h);
}

static void status_frame_done(struct holder *h) {
  struct status_parser *s = &h->status;
  s->line[s->len] = '\0';
  char step[16];
  unsigned err;
  if (sscanf(s->line, "E %15[A-Za-z0-9_-] %u", step, &err) == 2 && s->frame == SF_NONE) {
    s->frame = SF_E;
    snprintf(s->step, sizeof s->step, "%s", step);
    s->err = err;
  } else {
    logmsg("malformed status frame: %s", s->line);
  }
  s->in_line = false;
  s->len = 0;
}

static enum status_read read_status(struct holder *h) {
  struct status_parser *s = &h->status;
  char buf[64];
  ssize_t n = read(s->fd, buf, sizeof buf);
  if (n < 0) return SR_WOULDBLOCK;
  if (n == 0) {
    close(s->fd);
    s->fd = -1;
    if (s->frame == SF_NONE && s->saw_s) {
      emit(h, "ready %s", h->nonce);
      if (h->phase == PH_GO_SENT) h->phase = PH_RUNNING;
    } else if (!s->saw_s && s->frame == SF_NONE) {
      logmsg("status pipe closed before S");
    }
    return SR_EOF;
  }
  for (ssize_t i = 0; i < n; i++) {
    char c = buf[i];
    if (s->in_line) {
      if (s->len < sizeof s->line - 1) s->line[s->len++] = c;
      if (c == '\n') status_frame_done(h);
    } else if (c == 'S' && !s->saw_s) {
      s->saw_s = true;
      if (h->phase == PH_FORKED) h->phase = PH_CREATED;
      emit(h, "created %s %d", h->nonce, (int)h->pid);
    } else if (c == 'C') {
      if (s->frame == SF_NONE) s->frame = SF_C;
    } else if (c == 'E') {
      s->in_line = true;
      s->len = 0;
      s->line[s->len++] = c;
    } else {
      logmsg("unexpected status byte %d", (int)(unsigned char)c);
    }
  }
  return SR_DATA;
}

/* ---- daemon death --------------------------------------------------------- */

static void on_cmd_eof(struct holder *h) {
  close(h->cmd_fd);
  h->cmd_fd = -1;
  if (h->identity == ID_NONE) finish(h, CODE_NEVER_LAUNCHED);
  if (h->identity == ID_REAPED) { begin_probing(h); return; }
  if (h->phase < PH_GO_SENT && !h->observed) { cancel(h); return; }
  int err = signal_group(h, SIGTERM);
  if (err) logmsg("daemon-death term: %s", strerror(err));
  signal_group(h, SIGCONT);
  h->dying = DY_TERM_SENT;
  h->deadline_ms = now_ms() + TERM_WAIT_MS;
}

static void tick(struct holder *h) {
  if (h->dying == DY_TERM_SENT) {
    int err = signal_group(h, SIGKILL);
    if (err) logmsg("daemon-death kill: %s", strerror(err));
    h->dying = DY_KILL_SENT;
    if (h->observed) { reap(h); begin_probing(h); }
  } else if (h->dying == DY_PROBING) {
    int err = signal_group(h, 0);
    if (err == ESRCH) finish(h, CODE_OK);
    h->deadline_ms = now_ms() + PROBE_INTERVAL_MS;
  }
}

/* ---- command parsing ------------------------------------------------------ */

static bool parse_nonce(const char *s, char *out) {
  size_t n = strlen(s);
  if (n == 0 || n > NONCE_MAX) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
    if (!ok) return false;
  }
  memcpy(out, s, n + 1);
  return true;
}

static bool parse_count(const char *line, size_t max, size_t *out) {
  if (line[0] == '\0' || strlen(line) > 10) return false;
  for (const char *p = line; *p; p++) if (*p < '0' || *p > '9') return false;
  unsigned long long v = strtoull(line, NULL, 10);
  if (v > max) return false;
  *out = (size_t)v;
  return true;
}

static void launch_reset(struct cmd_parser *c) {
  struct launch *l = &c->launch;
  free(l->file);
  free(l->cwd);
  for (size_t i = 0; l->argv && i <= l->argc + 1; i++) free(l->argv[i]);
  free(l->argv);
  for (size_t i = 0; l->envp && i < l->envc; i++) free(l->envp[i]);
  free(l->envp);
  memset(l, 0, sizeof *l);
  c->step = LS_NONE;
  c->mode = CM_LINE;
}

static void handle_command_line(struct holder *h, char *line) {
  char *space = strchr(line, ' ');
  if (!space || strchr(space + 1, ' ')) { logmsg("malformed command: %.40s", line); return; }
  *space = '\0';
  char nonce[NONCE_MAX + 1];
  if (!parse_nonce(space + 1, nonce)) { logmsg("malformed nonce for %s", line); return; }
  if (strcmp(line, "launch") == 0) {
    launch_reset(&h->cmd);
    memcpy(h->cmd.launch.nonce, nonce, sizeof nonce);
    h->cmd.step = LS_FILE;
  } else if (strcmp(line, "go") == 0) on_go(h, nonce);
  else if (strcmp(line, "abandon") == 0) on_abandon(h);
  else if (strcmp(line, "term") == 0) on_rung(h, "term", SIGTERM, nonce);
  else if (strcmp(line, "kill") == 0) on_rung(h, "kill", SIGKILL, nonce);
  else if (strcmp(line, "reap") == 0) on_reap(h, nonce);
  else if (strcmp(line, "probe") == 0) on_probe(h, nonce);
  else if (strcmp(line, "exit") == 0) finish(h, CODE_OK);
  else logmsg("unknown command: %.40s", line);
}

/* A length line inside a launch frame: counts advance the step, lengths switch to byte mode. */
static void handle_launch_line(struct holder *h, const char *line) {
  struct cmd_parser *c = &h->cmd;
  struct launch *l = &c->launch;
  size_t v;
  bool is_count = c->step == LS_ARGC || c->step == LS_ENVC;
  if (!parse_count(line, is_count ? COUNT_MAX : FIELD_MAX, &v)) {
    logmsg("malformed launch %s line: %.40s", is_count ? "count" : "length", line);
    launch_reset(c);
    return;
  }
  if (c->step == LS_ARGC) {
    l->argc = v;
    l->argv = calloc(v + 2, sizeof *l->argv);
    if (!l->argv) { logmsg("out of memory"); finish(h, CODE_INTERNAL); }
    c->step = v ? LS_ARG : LS_ENVC;
  } else if (c->step == LS_ENVC) {
    l->envc = v;
    l->envp = calloc(v + 1, sizeof *l->envp);
    if (!l->envp) { logmsg("out of memory"); finish(h, CODE_INTERNAL); }
    c->step = v ? LS_ENV : LS_CWD;
  } else {
    c->need = v;
    c->mode = CM_BYTES;
  }
}

static void handle_launch_bytes(struct holder *h, char *bytes) {
  struct cmd_parser *c = &h->cmd;
  struct launch *l = &c->launch;
  c->mode = CM_LINE;
  switch (c->step) {
    case LS_FILE: l->file = bytes; c->step = LS_ARGC; return;
    case LS_ARG: l->argv[++l->argi] = bytes; if (l->argi == l->argc) c->step = LS_ENVC; return;
    case LS_ENV: l->envp[l->envi++] = bytes; if (l->envi == l->envc) c->step = LS_CWD; return;
    case LS_CWD:
      l->cwd = bytes;
      l->argv[0] = strdup(l->file);
      if (!l->argv[0]) { logmsg("out of memory"); finish(h, CODE_INTERNAL); }
      do_launch(h, l);
      launch_reset(c);
      return;
    case LS_NONE: case LS_ARGC: case LS_ENVC: free(bytes); launch_reset(c); return;
  }
}

static void consume_commands(struct holder *h) {
  struct cmd_parser *c = &h->cmd;
  for (;;) {
    if (c->mode == CM_BYTES) {
      if (c->len < c->need) return;
      char *bytes = malloc(c->need + 1);
      if (!bytes) { logmsg("out of memory"); finish(h, CODE_INTERNAL); }
      memcpy(bytes, c->buf, c->need);
      bytes[c->need] = '\0';
      memmove(c->buf, c->buf + c->need, c->len - c->need);
      c->len -= c->need;
      handle_launch_bytes(h, bytes);
      continue;
    }
    char *nl = memchr(c->buf, '\n', c->len);
    if (!nl) {
      if (c->len > FIELD_MAX) { logmsg("command line too long; discarding"); c->len = 0; }
      return;
    }
    *nl = '\0';
    size_t used = (size_t)(nl - c->buf) + 1;
    char line[256];
    bool fits = used <= sizeof line;
    if (fits) memcpy(line, c->buf, used);
    memmove(c->buf, c->buf + used, c->len - used);
    c->len -= used;
    if (!fits) { logmsg("command line too long; ignored"); continue; }
    if (c->step == LS_NONE) handle_command_line(h, line);
    else handle_launch_line(h, line);
  }
}

static void read_commands(struct holder *h) {
  struct cmd_parser *c = &h->cmd;
  if (c->cap - c->len < 4096) {
    size_t cap = c->cap ? c->cap * 2 : 8192;
    char *buf = realloc(c->buf, cap);
    if (!buf) { logmsg("out of memory"); finish(h, CODE_INTERNAL); }
    c->buf = buf;
    c->cap = cap;
  }
  ssize_t n = read(h->cmd_fd, c->buf + c->len, c->cap - c->len);
  if (n < 0) { if (errno == EAGAIN || errno == EINTR) return; logmsg("command read: %s", strerror(errno)); n = 0; }
  if (n == 0) { consume_commands(h); on_cmd_eof(h); return; }
  c->len += (size_t)n;
  consume_commands(h);
}

/* ---- main loop ------------------------------------------------------------ */

int main(void) {
  static struct holder h;
  h.cmd_fd = SLOT_CMD;
  h.receipt_fd = SLOT_RECEIPT;
  h.go_writer = -1;
  h.status.fd = -1;
  for (int fd = 0; fd <= 2; fd++) set_flags(fd, O_NONBLOCK, true);
  int self[2];
  if (pipe(self) != 0) { logmsg("self-pipe: %s", strerror(errno)); return CODE_INTERNAL; }
  h.self_r = self[0];
  g_self_w = self[1];
  set_flags(self[0], O_NONBLOCK, true);
  set_flags(self[1], O_NONBLOCK, true);

  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_sigchld;
  sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  sigemptyset(&sa.sa_mask);
  if (sigaction(SIGCHLD, &sa, NULL) != 0) return CODE_INTERNAL;
  const int ignored[] = { SIGTERM, SIGINT, SIGHUP, SIGPIPE };
  for (size_t i = 0; i < sizeof ignored / sizeof ignored[0]; i++) signal(ignored[i], SIG_IGN);

  emit(&h, "hello vonvon-holder %d", PROTOCOL_VERSION);
  for (;;) {
    struct pollfd fds[4];
    int cmd_i = -1, self_i = -1, status_i = -1, receipt_i = -1, n = 0;
    if (h.cmd_fd >= 0 && h.out.count + 2 <= QUEUE_CAP) { cmd_i = n; fds[n++] = (struct pollfd){ .fd = h.cmd_fd, .events = POLLIN }; }
    self_i = n;
    fds[n++] = (struct pollfd){ .fd = h.self_r, .events = POLLIN };
    if (h.status.fd >= 0) { status_i = n; fds[n++] = (struct pollfd){ .fd = h.status.fd, .events = POLLIN }; }
    if (h.receipt_fd >= 0 && h.out.count > 0) { receipt_i = n; fds[n++] = (struct pollfd){ .fd = h.receipt_fd, .events = POLLOUT }; }
    int timeout = -1;
    if (h.dying == DY_TERM_SENT || h.dying == DY_PROBING) {
      int64_t left = h.deadline_ms - now_ms();
      timeout = left < 0 ? 0 : (int)left;
    }
    if (poll(fds, (nfds_t)n, timeout) < 0 && errno != EINTR) { logmsg("poll: %s", strerror(errno)); return CODE_INTERNAL; }
    if (status_i >= 0 && fds[status_i].revents) read_status(&h);
    if (fds[self_i].revents) {
      char drain[64];
      while (read(h.self_r, drain, sizeof drain) > 0) { /* coalesce every pending wake-up */ }
      observe(&h);
    }
    if (cmd_i >= 0 && fds[cmd_i].revents) read_commands(&h);
    if (receipt_i >= 0 && fds[receipt_i].revents) flush_receipts(&h);
    if (h.dying != DY_NO && h.dying != DY_KILL_SENT && now_ms() >= h.deadline_ms) tick(&h);
  }
}
