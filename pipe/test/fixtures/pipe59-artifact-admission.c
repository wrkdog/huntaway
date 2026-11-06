/* Test-linked Darwin syscall simulation. This file is never installed. */
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *scenario;
static const char *parent_path;
static const char *stage_name;
static dev_t destination_dev;
static ino_t destination_ino;
static dev_t held_parent_dev;
static ino_t held_parent_ino;
static int held_parent_seen;
static int destination_created;
static int destination_writes;
static int source_reads;
static int file_syncs;

static int is_parent(int fd)
{
    struct stat a, b;
    if (fstat(fd, &a) != 0) return 0;
    if (held_parent_seen && a.st_dev == held_parent_dev && a.st_ino == held_parent_ino)
        return 1;
    return stat(parent_path, &b) == 0 &&
        a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

static int is_middle(int fd)
{
    char middle[PATH_MAX];
    size_t n = strlen(parent_path);
    if (n >= sizeof(middle)) return 0;
    memcpy(middle, parent_path, n + 1);
    char *last = strrchr(middle, '/');
    if (last == NULL || last == middle) return 0;
    *last = '\0';
    struct stat a, b;
    return fstat(fd, &a) == 0 && stat(middle, &b) == 0 &&
        a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

static int middle_fault(void)
{
    return !strcmp(scenario, "unsafe_middle") || !strcmp(scenario, "unknown_middle") ||
        !strcmp(scenario, "unsafe_mount_middle") || !strcmp(scenario, "unknown_mount_middle") ||
        !strcmp(scenario, "unsafe_acl_middle") || !strcmp(scenario, "unknown_acl_middle");
}

static int is_destination(int fd)
{
    struct stat st;
    return destination_created && fstat(fd, &st) == 0 &&
        st.st_dev == destination_dev && st.st_ino == destination_ino;
}

static void make_stage_alias(void)
{
    char source[PATH_MAX], alias[PATH_MAX];
    int a = snprintf(source, sizeof(source), "%s/%s", parent_path, stage_name);
    int b = snprintf(alias, sizeof(alias), "%s.alias", parent_path);
    if (a < 0 || b < 0 || (size_t)a >= sizeof(source) ||
        (size_t)b >= sizeof(alias) || link(source, alias) != 0) _exit(93);
}

static int fixture_open(const char *path, int flags, ...)
{
    if (strcmp(path, "/") != 0) _exit(90); /* No source pathname or data root. */
    return open(path, flags);
}

static int fixture_openat(int fd, const char *name, int flags, ...)
{
    if (fd == 3) _exit(90); /* The inherited source FD is never a pathname root. */
    if (name[0] == '\0' || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")) _exit(91);
    if (!strcmp(scenario, "unsafe_ancestor") || !strcmp(scenario, "unknown_ancestor") ||
        !strcmp(scenario, "unsafe_mount") || !strcmp(scenario, "unknown_mount") ||
        !strcmp(scenario, "unsafe_acl") || !strcmp(scenario, "unknown_acl")) _exit(92);
    if (middle_fault() && is_middle(fd)) _exit(92);
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = (mode_t)va_arg(args, int);
        va_end(args);
        if (!is_parent(fd) || !(flags & O_EXCL) || (mode & 0111)) _exit(93);
        struct stat held_parent;
        if (fstat(fd, &held_parent) != 0) _exit(93);
        held_parent_dev = held_parent.st_dev;
        held_parent_ino = held_parent.st_ino;
        held_parent_seen = 1;
        if (!strcmp(scenario, "parent_detached") && !destination_created) {
            char moved[PATH_MAX];
            int length = snprintf(moved, sizeof(moved), "%s.detached", parent_path);
            if (length < 0 || (size_t)length >= sizeof(moved) ||
                rename(parent_path, moved) != 0 || mkdir(parent_path, 0700) != 0)
                _exit(93);
        }
        int out = openat(fd, name, flags, mode);
        if (out >= 0) {
            struct stat st;
            if (fstat(out, &st) != 0) _exit(93);
            destination_dev = st.st_dev;
            destination_ino = st.st_ino;
            destination_created = 1;
            if (!strcmp(scenario, "extra_hardlink")) make_stage_alias();
        }
        return out;
    }
    return openat(fd, name, flags);
}

static int fixture_fstat(int fd, struct stat *st)
{
    if (fstat(fd, st) != 0) return -1;
    if (fd == 3 && !strcmp(scenario, "special_source")) {
        st->st_mode = (st->st_mode & ~S_IFMT) | S_IFIFO;
        return 0;
    }
    if (fd == 3 && !strcmp(scenario, "oversize")) st->st_size = 512 * 1024 * 1024 + 1;
    if (is_destination(fd)) {
        /* Test-only protected APFS positive: the created file is root-owned. */
        st->st_uid = 0;
        st->st_mode &= ~(S_IWGRP | S_IWOTH);
    }
    if (S_ISDIR(st->st_mode)) {
        if (is_parent(fd) && !strcmp(scenario, "unknown_parent")) { errno = EIO; return -1; }
        st->st_uid = is_parent(fd) && (!strcmp(scenario, "unsafe_parent") ||
            (!strcmp(scenario, "parent_flip") && destination_created)) ? 501 : 0;
        if (is_parent(fd)) st->st_mode &= ~0077;
        else st->st_mode &= ~(S_IWGRP | S_IWOTH);
        if (is_parent(fd) && (!strcmp(scenario, "searchable_parent") ||
            !strcmp(scenario, "late_hardlink"))) st->st_mode |= S_IXOTH;
        if (!strcmp(scenario, "unsafe_ancestor") && !is_parent(fd)) st->st_mode |= S_IWOTH;
        if (!strcmp(scenario, "unknown_ancestor") && !is_parent(fd)) { errno = EIO; return -1; }
        if (!strcmp(scenario, "unsafe_middle") && is_middle(fd)) st->st_mode |= S_IWOTH;
        if (!strcmp(scenario, "unknown_middle") && is_middle(fd)) { errno = EIO; return -1; }
    }
    return 0;
}

static int fixture_fstatat(int fd, const char *name, struct stat *st, int flags)
{
    if (fd == 3) _exit(90);
    if (!strcmp(scenario, "unsafe_ancestor") || !strcmp(scenario, "unknown_ancestor") ||
        !strcmp(scenario, "unsafe_mount") || !strcmp(scenario, "unknown_mount") ||
        !strcmp(scenario, "unsafe_acl") || !strcmp(scenario, "unknown_acl") ||
        (is_parent(fd) && (!strcmp(scenario, "unsafe_parent") || !strcmp(scenario, "unknown_parent"))))
        _exit(92); /* Do not inspect below an unsafe or unknown descriptor. */
    if (middle_fault() && is_middle(fd)) _exit(92);
    int result = fstatat(fd, name, st, flags);
    if (result == 0 && S_ISDIR(st->st_mode)) {
        st->st_uid = 0;
        st->st_mode &= ~(S_IWGRP | S_IWOTH);
    }
    return result;
}

static int fixture_fstatfs(int fd, struct statfs *fs)
{
    if (!strcmp(scenario, "unknown_mount") ||
        (!strcmp(scenario, "unknown_mount_middle") && is_middle(fd))) { errno = EIO; return -1; }
    memset(fs, 0, sizeof(*fs));
    memcpy(fs->f_fstypename, "apfs", 5);
    fs->f_owner = !strcmp(scenario, "unsafe_mount") ||
        (!strcmp(scenario, "unsafe_mount_middle") && is_middle(fd)) ? 501 : 0;
    (void)fd;
    return 0;
}

static acl_t fixture_acl_get_fd_np(int fd, acl_type_t type)
{
    (void)type;
    if (!strcmp(scenario, "unknown_acl") ||
        (!strcmp(scenario, "unknown_acl_middle") && is_middle(fd))) { errno = EIO; return NULL; }
    if (!strcmp(scenario, "unsafe_acl") ||
        (!strcmp(scenario, "unsafe_acl_middle") && is_middle(fd)) ||
        (!strcmp(scenario, "search_acl_parent") && is_parent(fd)) ||
        (!strcmp(scenario, "inherited_acl") && is_destination(fd))) return (acl_t)(uintptr_t)1;
    errno = ENOENT;
    return NULL;
}

static int fixture_acl_get_entry(acl_t acl, int entry_id, acl_entry_t *entry)
{
    (void)acl;
    if (entry_id != ACL_FIRST_ENTRY) { errno = EINVAL; return -1; }
    *entry = (acl_entry_t)(uintptr_t)1;
    return 0;
}

static int fixture_acl_get_tag_type(acl_entry_t entry, acl_tag_t *tag)
{
    (void)entry; *tag = ACL_EXTENDED_ALLOW; return 0;
}

static int fixture_acl_get_permset_mask_np(acl_entry_t entry, acl_permset_mask_t *mask)
{
    (void)entry;
    *mask = !strcmp(scenario, "search_acl_parent") ? ACL_EXECUTE : ACL_WRITE_DATA;
    return 0;
}

static int fixture_acl_free(void *acl) { (void)acl; return 0; }

static ssize_t fixture_read(int fd, void *buf, size_t count)
{
    if (fd == 3 && !strcmp(scenario, "special_source")) _exit(94);
    return read(fd, buf, count);
}

static ssize_t fixture_pread(int fd, void *buf, size_t count, off_t offset)
{
    if (fd == 3 && !strcmp(scenario, "special_source")) _exit(94);
    if (fd == 3 && !strcmp(scenario, "oversize")) _exit(98);
    if (fd == 3 && !strcmp(scenario, "source_flip_during_copy") && ++source_reads == 2) {
        const char changed = 'X';
        if (pwrite(fd, &changed, 1, 10) != 1) _exit(98);
    }
    if (is_destination(fd) && !strcmp(scenario, "dest_corrupt_after_copy")) {
        const char changed = 'Y';
        if (pwrite(fd, &changed, 1, 10) != 1) _exit(98);
    }
    return pread(fd, buf, count, offset);
}

static ssize_t fixture_write(int fd, const void *buf, size_t count)
{
    if (fd == 1 && !strcmp(scenario, "failed_output")) { errno = EIO; return -1; }
    if (fd == 3) _exit(95);
    if (is_destination(fd)) {
        if (!strcmp(scenario, "zero_write")) return 0;
        if (!strcmp(scenario, "failed_write")) { errno = EIO; return -1; }
        if (!strcmp(scenario, "short_write") && ++destination_writes == 1)
            return write(fd, buf, count > 1 ? 1 : count);
        if (!strcmp(scenario, "short_then_failed_write")) {
            if (++destination_writes > 1) { errno = EIO; return -1; }
            return write(fd, buf, count > 1 ? 1 : count);
        }
    }
    return write(fd, buf, count);
}

static ssize_t fixture_pwrite(int fd, const void *buf, size_t count, off_t offset)
{
    if (fd == 3) _exit(95);
    if (is_destination(fd)) {
        if (!strcmp(scenario, "zero_write")) return 0;
        if (!strcmp(scenario, "failed_write")) { errno = EIO; return -1; }
        if (!strcmp(scenario, "short_write") && ++destination_writes == 1)
            return pwrite(fd, buf, count > 1 ? 1 : count, offset);
        if (!strcmp(scenario, "short_then_failed_write")) {
            if (++destination_writes > 1) { errno = EIO; return -1; }
            return pwrite(fd, buf, count > 1 ? 1 : count, offset);
        }
    }
    return pwrite(fd, buf, count, offset);
}

static int fixture_fsync(int fd)
{
    if (!strcmp(scenario, "late_hardlink") && is_destination(fd)) make_stage_alias();
    if (!strcmp(scenario, "failed_file_sync") && is_destination(fd)) { errno = EIO; return -1; }
    if (!strcmp(scenario, "failed_parent_sync") && is_parent(fd) && ++file_syncs > 0) {
        errno = EIO; return -1;
    }
    return fsync(fd);
}

static int fixture_execve(const char *path, char *const argv[], char *const envp[])
{
    (void)path; (void)argv; (void)envp; _exit(96);
}

#define open fixture_open
#define openat fixture_openat
#define fstat fixture_fstat
#define fstatat fixture_fstatat
#define fstatfs fixture_fstatfs
#define acl_get_fd_np fixture_acl_get_fd_np
#define acl_get_entry fixture_acl_get_entry
#define acl_get_tag_type fixture_acl_get_tag_type
#define acl_get_permset_mask_np fixture_acl_get_permset_mask_np
#define acl_free fixture_acl_free
#define read fixture_read
#define pread fixture_pread
#define write fixture_write
#define pwrite fixture_pwrite
#define fsync fixture_fsync
#define execve fixture_execve
#include "../../native/protected-artifact-admission.c"
#undef open
#undef openat
#undef fstat
#undef fstatat
#undef fstatfs
#undef acl_get_fd_np
#undef acl_get_entry
#undef acl_get_tag_type
#undef acl_get_permset_mask_np
#undef acl_free
#undef read
#undef pread
#undef write
#undef pwrite
#undef fsync
#undef execve

int main(int argc, char **argv)
{
    if (argc != 5) return 97;
    scenario = getenv("PIPE59_CASE");
    if (scenario == NULL) return 98;
    parent_path = argv[1];
    stage_name = argv[2];
    char *end;
    errno = 0;
    unsigned long long size = strtoull(argv[3], &end, 10);
    if (errno || *end) return 99;
    if (strlen(argv[4]) != 64) return 99;
    uint8_t digest[32];
    for (int i = 0; i < 32; ++i) {
        unsigned int byte;
        if (sscanf(argv[4] + 2 * i, "%2x", &byte) != 1) return 99;
        digest[i] = (uint8_t)byte;
    }
    return pipe_admit_artifact(3, (uint64_t)size, digest, parent_path, argv[2], 1);
}
