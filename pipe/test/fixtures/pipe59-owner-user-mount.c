/* Test-only synthetic APFS statfs response. It never mounts or changes a volume. */
#define fstatfs fixture_fstatfs
#define main observer_original_main
#include "../../native/protected-path-observer.c"
#undef main
#undef fstatfs

int fixture_fstatfs(int fd, struct statfs *fs)
{
    (void)fd;
    memset(fs, 0, sizeof(*fs));
#ifdef PIPE59_TEST_NON_APFS
    memcpy(fs->f_fstypename, "hfs", 4);
#else
    memcpy(fs->f_fstypename, "apfs", 5);
#endif
#ifdef PIPE59_TEST_USER_MOUNT
    fs->f_owner = getuid();
#else
    fs->f_owner = 0;
#endif
#ifdef PIPE59_TEST_NOOWNERS
    fs->f_flags = MNT_IGNORE_OWNERSHIP;
#endif
    return 0;
}

int main(int argc, char **argv)
{
    return observer_original_main(argc, argv);
}
