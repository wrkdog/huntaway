/* Test-only synthetic statfs response; this never mounts or modifies a volume. */
#define fstatfs fixture_fstatfs
#define main observer_original_main
#include "../../native/protected-path-observer.c"
#undef main
#undef fstatfs

int fixture_fstatfs(int fd, struct statfs *fs)
{
    (void)fd;
    memset(fs, 0, sizeof(*fs));
    memcpy(fs->f_fstypename, "apfs", 5);
#ifdef PIPE59_TEST_NOOWNERS
    fs->f_flags = MNT_IGNORE_OWNERSHIP;
    fs->f_owner = 0;
#else
    fs->f_owner = 501;
#endif
    return 0;
}

int main(int argc, char **argv)
{
    return observer_original_main(argc, argv);
}
