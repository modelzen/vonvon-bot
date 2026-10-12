#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <libproc.h>
#include <sys/proc_info.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end = NULL;
  errno = 0;
  long pid = strtol(argv[1], &end, 10);
  if (errno || !end || *end || pid <= 0 || pid > INT_MAX) return 2;

  struct proc_bsdinfo info = {0};
  errno = 0;
  int size = proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info));
  if (size != (int)sizeof(info)) {
    if (errno == ESRCH) puts("{\"kind\":\"missing\"}");
    else puts("{\"kind\":\"unknown\",\"reason\":\"proc_pidinfo did not return a birth identity\"}");
    return 0;
  }
  if (info.pbi_pid != (uint32_t)pid || !info.pbi_pgid || info.pbi_start_tvusec >= 1000000
      || !info.pbi_start_tvsec || info.pbi_start_tvsec >= 4398046511ULL) {
    puts("{\"kind\":\"unknown\",\"reason\":\"Unrepresentable macOS process birth identity\"}");
    return 0;
  }
  uint64_t milliseconds = info.pbi_start_tvsec * 1000 + info.pbi_start_tvusec / 1000;
  printf("{\"kind\":\"live\",\"startedAtMs\":%llu.%03llu,\"groupId\":%u}\n",
    (unsigned long long)milliseconds, (unsigned long long)(info.pbi_start_tvusec % 1000), info.pbi_pgid);
  return 0;
}
