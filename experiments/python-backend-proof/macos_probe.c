#include <EndpointSecurity/EndpointSecurity.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

static off_t size(const char *path) {
    struct stat s;
    return stat(path, &s) == 0 ? s.st_size : 0;
}

static void check(int value, const char *what) {
    if (!value) { perror(what); exit(1); }
}

static void writer(const char *path) {
    int fd = open(path, O_CREAT | O_APPEND | O_WRONLY, 0600);
    check(fd >= 0, "open marker");
    // Every fixture terminates itself even when the supervising probe fails.
    double until = now() + 2.0;
    while (now() < until) {
        check(write(fd, "x", 1) == 1, "write marker");
        usleep(10000);
    }
    close(fd);
}

static pid_t spawn_stopped(const char *self, const char *mode, const char *path) {
    posix_spawnattr_t attr;
    check(posix_spawnattr_init(&attr) == 0, "spawnattr");
    check(posix_spawnattr_setflags(&attr, POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_SETPGROUP) == 0, "flags");
    check(posix_spawnattr_setpgroup(&attr, 0) == 0, "pgroup");
    char *args[] = {(char *)self, (char *)mode, (char *)path, NULL};
    pid_t pid;
    int rc = posix_spawn(&pid, self, NULL, &attr, args, environ);
    posix_spawnattr_destroy(&attr);
    check(rc == 0, "spawn");
    return pid;
}

static void wait_marker(const char *path) {
    double until = now() + 2;
    while (size(path) == 0 && now() < until) usleep(1000);
    check(size(path) > 0, "marker timeout");
}

static void kill_owned(pid_t pid) {
    // A direct, unreaped child pins this PID until waitpid; never target discovered processes.
    check(kill(-pid, SIGKILL) == 0, "kill owned group");
    int status;
    check(waitpid(pid, &status, 0) == pid, "wait owned child");
}

int main(int argc, char **argv) {
    check(argc == 3, "arguments");
    if (strcmp(argv[1], "writer") == 0) { writer(argv[2]); return 0; }
    if (strcmp(argv[1], "escape") == 0) {
        pid_t first = fork();
        check(first >= 0, "first fork");
        if (first == 0) {
            check(setsid() >= 0, "setsid");
            pid_t second = fork();
            check(second >= 0, "second fork");
            if (second > 0) _exit(0);
            writer(argv[2]);
            _exit(0);
        }
        int status;
        waitpid(first, &status, 0);
        sleep(4);
        return 0;
    }
    check(strcmp(argv[1], "probe") == 0, "mode");
    char gated[4096], regular[4096], escaped[4096];
    snprintf(gated, sizeof gated, "%s/gated", argv[2]);
    snprintf(regular, sizeof regular, "%s/regular", argv[2]);
    snprintf(escaped, sizeof escaped, "%s/escaped", argv[2]);
    pid_t pid = spawn_stopped(argv[0], "writer", gated);
    usleep(150000);
    int gate_held = size(gated) == 0;
    kill_owned(pid);
    int no_effect_before_release = size(gated) == 0;

    pid = spawn_stopped(argv[0], "writer", regular);
    check(kill(pid, SIGCONT) == 0, "release");
    wait_marker(regular);
    kill_owned(pid);
    off_t before = size(regular);
    usleep(150000);
    int regular_stopped = before == size(regular);

    pid = spawn_stopped(argv[0], "escape", escaped);
    check(kill(pid, SIGCONT) == 0, "release escape");
    wait_marker(escaped);
    kill_owned(pid);
    before = size(escaped);
    usleep(150000);
    int escaped_continues = size(escaped) > before;
    // Wait out the fixture's deadline, then verify its side effects have ceased.
    usleep(2200000);
    before = size(escaped);
    usleep(150000);
    int fixture_finished = before == size(escaped);

    es_client_t *client = NULL;
    es_new_client_result_t es_result = es_new_descendants_client(&client,
        ^(es_client_t *c, const es_message_t *message) { (void)c; (void)message; });
    if (client) es_delete_client(client);
    printf("{\"suspended_spawn_blocks_code\":%s,\"kill_before_release_has_no_effect\":%s,"
           "\"direct_child_cleanup\":%s,\"setsid_double_fork_survives_killpg\":%s,"
           "\"fixture_finished\":%s,\"es_result\":%d,\"es_not_entitled_code\":%d}\n",
           gate_held ? "true" : "false", no_effect_before_release ? "true" : "false",
           regular_stopped ? "true" : "false", escaped_continues ? "true" : "false",
           fixture_finished ? "true" : "false", es_result, ES_NEW_CLIENT_RESULT_ERR_NOT_ENTITLED);
    return gate_held && no_effect_before_release && regular_stopped && escaped_continues && fixture_finished ? 0 : 1;
}
