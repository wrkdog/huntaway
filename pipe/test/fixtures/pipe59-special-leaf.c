/* Test-only syscall stand-ins: model a FIFO at /Library without creating one. */
#define fstatat fixture_fstatat
#define openat fixture_openat
#define main observer_original_main
#include "../../native/protected-path-observer.c"
#undef main
#undef openat
#undef fstatat

static int leaf_opened;

int fixture_fstatat(int fd, const char *name, struct stat *st, int flags)
{
    (void)fd;
    (void)flags;
    if (strcmp(name, "Library") != 0) return -1;
    memset(st, 0, sizeof(*st));
    st->st_mode = S_IFIFO | 0644;
    st->st_uid = 0;
    return 0;
}

int fixture_openat(int fd, const char *name, int flags, ...)
{
    (void)fd;
    (void)name;
    (void)flags;
    leaf_opened = 1;
    errno = EIO;
    return -1;
}

int main(int argc, char **argv)
{
    int result = observer_original_main(argc, argv);
    return leaf_opened ? 99 : result;
}
