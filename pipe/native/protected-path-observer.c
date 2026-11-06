/* Source-only diagnostic. A candidate checks only the observed path's
 * ownership, writability, and mount. It does not prove token confidentiality,
 * directory descendants, independent release provenance, runtime/launch
 * closure, or future path stability. A publisher must repeat its own descriptor
 * checks; this result authorizes no installation or credential move. */
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/stat.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define MAX_PATH_BYTES 4096
#define MAX_DEPTH 64
#define MAX_ACL_ENTRIES 128

enum reason {
    INVALID_PATH,
    OPEN_FAILED,
    SYMLINK,
    NOT_DIRECTORY,
    STAT_FAILED,
    NOT_ROOT_OWNED,
    WRITABLE_ANCESTOR,
    WRITABLE_LEAF,
    MOUNT_UNKNOWN,
    NOT_APFS,
    OWNERSHIP_IGNORED,
    UNTRUSTED_MOUNT_OWNER,
    ACL_UNKNOWN,
    ACL_WRITE_ALLOW,
    SPECIAL_FILE,
    IDENTITY_CHANGED,
    INVALID_IDENTITY,
    UNTRUSTED_PATH_OWNER,
    REASON_COUNT
};

static const char *const reason_names[REASON_COUNT] = {
    "invalid_path", "open_failed", "symlink", "not_directory",
    "stat_failed", "not_root_owned", "writable_ancestor", "writable_leaf",
    "mount_unknown", "not_apfs", "ownership_ignored",
    "untrusted_mount_owner", "acl_unknown", "acl_write_allow",
    "special_file", "identity_changed", "invalid_identity",
    "untrusted_path_owner"
};

static bool found[REASON_COUNT];
static bool unsafe;
static bool uncertain;

static void mark(enum reason reason, bool refused)
{
    found[reason] = true;
    if (refused) unsafe = true;
    else uncertain = true;
}

static void inspect_acl(int fd)
{
    errno = 0;
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    if (acl == NULL) {
        if (errno != ENOENT) mark(ACL_UNKNOWN, false);
        return;
    }

    const acl_permset_mask_t write_bits =
        ACL_WRITE_DATA | ACL_APPEND_DATA | ACL_DELETE | ACL_DELETE_CHILD |
        ACL_WRITE_ATTRIBUTES | ACL_WRITE_EXTATTRIBUTES | ACL_WRITE_SECURITY |
        ACL_CHANGE_OWNER;
    const acl_permset_mask_t known_bits = write_bits | ACL_READ_DATA |
        ACL_EXECUTE | ACL_READ_ATTRIBUTES | ACL_READ_EXTATTRIBUTES |
        ACL_READ_SECURITY | ACL_SYNCHRONIZE;
    acl_entry_t entry;
    int next = ACL_FIRST_ENTRY;
    for (int count = 0; count <= MAX_ACL_ENTRIES; ++count) {
        errno = 0;
        int result = acl_get_entry(acl, next, &entry);
        /* Darwin returns 0 for an entry and EINVAL after the last one. */
        if (result < 0 && count > 0 && errno == EINVAL) break;
        if (result != 0 || count == MAX_ACL_ENTRIES) {
            mark(ACL_UNKNOWN, false);
            break;
        }
        next = ACL_NEXT_ENTRY;
        acl_tag_t tag;
        acl_permset_mask_t permissions;
        if (acl_get_tag_type(entry, &tag) != 0 ||
            acl_get_permset_mask_np(entry, &permissions) != 0) {
            mark(ACL_UNKNOWN, false);
            continue;
        }
        if (tag != ACL_EXTENDED_ALLOW && tag != ACL_EXTENDED_DENY) {
            mark(ACL_UNKNOWN, false);
        } else if (tag == ACL_EXTENDED_ALLOW) {
            if ((permissions & write_bits) != 0) mark(ACL_WRITE_ALLOW, true);
            if ((permissions & ~known_bits) != 0) mark(ACL_UNKNOWN, false);
        }
    }
    if (acl_free(acl) != 0) mark(ACL_UNKNOWN, false);
}

static void inspect_fd(int fd, bool leaf, uid_t owner_uid)
{
    struct stat st;
    if (fstat(fd, &st) != 0) {
        mark(STAT_FAILED, false);
        return;
    }
    if (S_ISLNK(st.st_mode)) mark(SYMLINK, true);
    if (owner_uid == 0) {
        if (st.st_uid != 0) mark(NOT_ROOT_OWNED, true);
    } else if (st.st_uid != owner_uid && (leaf || st.st_uid != 0)) {
        mark(UNTRUSTED_PATH_OWNER, true);
    }
    if ((st.st_mode & (S_IWGRP | S_IWOTH)) != 0)
        mark(leaf ? WRITABLE_LEAF : WRITABLE_ANCESTOR, true);
    if (unsafe || uncertain) return;

    struct statfs fs;
    if (fstatfs(fd, &fs) != 0) {
        mark(MOUNT_UNKNOWN, false);
        return;
    }
    if ((fs.f_flags & MNT_IGNORE_OWNERSHIP) != 0)
        mark(OWNERSHIP_IGNORED, true);
    if (fs.f_owner == (uid_t)-1) mark(MOUNT_UNKNOWN, false);
    else if (fs.f_owner != 0)
        mark(UNTRUSTED_MOUNT_OWNER, true);
    if (fs.f_fstypename[0] == '\0' ||
        memchr(fs.f_fstypename, '\0', sizeof(fs.f_fstypename)) == NULL)
        mark(MOUNT_UNKNOWN, false);
    else if (strcmp(fs.f_fstypename, "apfs") != 0)
        mark(NOT_APFS, true);
    if (unsafe || uncertain) return;
    inspect_acl(fd);
}

static bool valid_path(const char *path)
{
    if (path == NULL || path[0] != '/') return false;
    size_t length = strnlen(path, MAX_PATH_BYTES + 1);
    if (length == 0 || length > MAX_PATH_BYTES) return false;
    if (length > 1 && path[length - 1] == '/') return false;
    int depth = 0;
    for (size_t start = 1; start < length;) {
        size_t end = start;
        while (end < length && path[end] != '/') ++end;
        size_t n = end - start;
        if (n == 0 || n > NAME_MAX ||
            (n == 1 && path[start] == '.') ||
            (n == 2 && path[start] == '.' && path[start + 1] == '.') ||
            ++depth > MAX_DEPTH) return false;
        start = end + 1;
    }
    return true;
}

static void observe(const char *path, uid_t owner_uid)
{
    if (!valid_path(path)) {
        mark(INVALID_PATH, true);
        return;
    }
    int parent = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) {
        mark(OPEN_FAILED, false);
        return;
    }
    inspect_fd(parent, path[1] == '\0', owner_uid);

    for (size_t start = 1; !unsafe && !uncertain && path[start] != '\0';) {
        size_t end = start;
        while (path[end] != '\0' && path[end] != '/') ++end;
        char name[NAME_MAX + 1];
        size_t n = end - start;
        memcpy(name, path + start, n);
        name[n] = '\0';
        bool leaf = path[end] == '\0';
        struct stat before;
        if (fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
            mark(OPEN_FAILED, false);
            break;
        }
        if (S_ISLNK(before.st_mode)) {
            mark(SYMLINK, true);
            break;
        }
        if (!leaf && !S_ISDIR(before.st_mode)) {
            mark(NOT_DIRECTORY, true);
            break;
        }
        if (leaf && !S_ISDIR(before.st_mode) && !S_ISREG(before.st_mode)) {
            mark(SPECIAL_FILE, true);
            break;
        }
        int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
        if (S_ISDIR(before.st_mode)) flags |= O_DIRECTORY;
        int child = openat(parent, name, flags);
        if (child < 0) {
            mark(errno == ELOOP ? SYMLINK : OPEN_FAILED, errno == ELOOP);
            break;
        }
        struct stat after;
        if (fstat(child, &after) != 0) {
            mark(STAT_FAILED, false);
        } else if (before.st_dev != after.st_dev ||
                   before.st_ino != after.st_ino ||
                   (before.st_mode & S_IFMT) != (after.st_mode & S_IFMT)) {
            mark(IDENTITY_CHANGED, false);
        }
        if (unsafe || uncertain) {
            close(child);
            break;
        }
        inspect_fd(child, leaf, owner_uid);
        close(parent);
        parent = child;
        if (leaf) break;
        start = end + 1;
    }
    close(parent);
}

int main(int argc, char **argv)
{
    if (argc == 2) {
        observe(argv[1], 0);
    } else if (argc == 3 && strcmp(argv[1], "--owner-user") == 0) {
        uid_t real_uid = getuid();
        uid_t effective_uid = geteuid();
        if (real_uid == 0 || real_uid != effective_uid)
            mark(INVALID_IDENTITY, true);
        else
            observe(argv[2], real_uid);
    } else {
        mark(INVALID_PATH, true);
    }

    const char *state = unsafe ? "refused" : uncertain ? "unknown" : "candidate";
    if (printf("{\"schemaVersion\":1,\"state\":\"%s\",\"reasons\":[", state) < 0)
        return 3;
    bool first = true;
    for (int i = 0; i < REASON_COUNT; ++i) {
        if (!found[i]) continue;
        if (printf("%s\"%s\"", first ? "" : ",", reason_names[i]) < 0)
            return 3;
        first = false;
    }
    if (puts("]}") < 0 || fflush(stdout) != 0) return 3;
    return unsafe ? 2 : uncertain ? 3 : 0;
}
