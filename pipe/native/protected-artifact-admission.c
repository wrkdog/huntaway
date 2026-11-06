/* Inert, source-only staging primitive. Its caller must authenticate the pin. */
#include <CommonCrypto/CommonDigest.h>
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/stat.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define PIPE_MAX_PATH 4096
#define PIPE_MAX_DEPTH 64
#define PIPE_MAX_ACL 128
#define PIPE_CHUNK 16384
#define PIPE_MAX_ARTIFACT (512ull << 20)

enum pipe_proof { PIPE_OK = 0, PIPE_REFUSED = 2, PIPE_UNKNOWN = 3 };

static enum pipe_proof pipe_acl(int fd)
{
    errno = 0;
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    if (acl == NULL) return errno == ENOENT ? PIPE_OK : PIPE_UNKNOWN;
    const acl_permset_mask_t write_bits = ACL_WRITE_DATA | ACL_APPEND_DATA |
        ACL_DELETE | ACL_DELETE_CHILD | ACL_WRITE_ATTRIBUTES |
        ACL_WRITE_EXTATTRIBUTES | ACL_WRITE_SECURITY | ACL_CHANGE_OWNER;
    const acl_permset_mask_t known_bits = write_bits | ACL_READ_DATA |
        ACL_EXECUTE | ACL_READ_ATTRIBUTES | ACL_READ_EXTATTRIBUTES |
        ACL_READ_SECURITY | ACL_SYNCHRONIZE;
    enum pipe_proof proof = PIPE_OK;
    acl_entry_t entry;
    int next = ACL_FIRST_ENTRY;
    for (int count = 0; count <= PIPE_MAX_ACL; ++count) {
        errno = 0;
        int result = acl_get_entry(acl, next, &entry);
        if (result < 0 && count > 0 && errno == EINVAL) break;
        if (result != 0 || count == PIPE_MAX_ACL) {
            proof = PIPE_UNKNOWN;
            break;
        }
        next = ACL_NEXT_ENTRY;
        acl_tag_t tag;
        acl_permset_mask_t permissions;
        if (acl_get_tag_type(entry, &tag) != 0 ||
            acl_get_permset_mask_np(entry, &permissions) != 0) {
            proof = PIPE_UNKNOWN;
            break;
        }
        if (tag != ACL_EXTENDED_ALLOW && tag != ACL_EXTENDED_DENY) {
            proof = PIPE_UNKNOWN;
            break;
        }
        if (tag == ACL_EXTENDED_ALLOW) {
            if ((permissions & write_bits) != 0) {
                proof = PIPE_REFUSED;
                break;
            }
            if ((permissions & ~known_bits) != 0) {
                proof = PIPE_UNKNOWN;
                break;
            }
        }
    }
    if (acl_free(acl) != 0) proof = PIPE_UNKNOWN;
    return proof;
}

static enum pipe_proof pipe_protected_fd(int fd, bool directory)
{
    struct stat st;
    if (fstat(fd, &st) != 0) return PIPE_UNKNOWN;
    if (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode))
        return PIPE_REFUSED;
    if (st.st_uid != 0 || (st.st_mode & (S_IWGRP | S_IWOTH)) != 0)
        return PIPE_REFUSED;
    if (!directory && (st.st_mode & 0111) != 0) return PIPE_REFUSED;

    struct statfs fs;
    if (fstatfs(fd, &fs) != 0) return PIPE_UNKNOWN;
    if ((fs.f_flags & MNT_IGNORE_OWNERSHIP) != 0) return PIPE_REFUSED;
    if (fs.f_owner == (uid_t)-1) return PIPE_UNKNOWN;
    if (fs.f_owner != 0) return PIPE_REFUSED;
    if (fs.f_fstypename[0] == '\0' ||
        memchr(fs.f_fstypename, '\0', sizeof(fs.f_fstypename)) == NULL)
        return PIPE_UNKNOWN;
    if (strcmp(fs.f_fstypename, "apfs") != 0) return PIPE_REFUSED;
    return pipe_acl(fd);
}

/* The stage parent is stricter than an ancestor: only root may search it. */
static enum pipe_proof pipe_private_parent(int fd)
{
    enum pipe_proof proof = pipe_protected_fd(fd, true);
    if (proof != PIPE_OK) return proof;
    struct stat st;
    if (fstat(fd, &st) != 0) return PIPE_UNKNOWN;
    if ((st.st_mode & 0077) != 0) return PIPE_REFUSED;
    errno = 0;
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    if (acl == NULL) return errno == ENOENT ? PIPE_OK : PIPE_UNKNOWN;
    /* A benign-looking ACL can still give another principal search access. */
    return acl_free(acl) == 0 ? PIPE_REFUSED : PIPE_UNKNOWN;
}

static bool pipe_name_byte(unsigned char c)
{
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
           (c >= 'A' && c <= 'Z') || c == '.' || c == '_' || c == '-';
}

static bool pipe_stage_name(const char *name)
{
    if (name == NULL) return false;
    size_t n = strnlen(name, NAME_MAX + 1);
    if (n == 0 || n > NAME_MAX || name[0] == '.' || name[0] == '-') return false;
    for (size_t i = 0; i < n; ++i)
        if (!pipe_name_byte((unsigned char)name[i])) return false;
    return true;
}

static bool pipe_path(const char *path)
{
    if (path == NULL || path[0] != '/') return false;
    size_t length = strnlen(path, PIPE_MAX_PATH + 1);
    if (length == 0 || length > PIPE_MAX_PATH ||
        (length > 1 && path[length - 1] == '/')) return false;
    int depth = 0;
    for (size_t start = 1; start < length;) {
        size_t end = start;
        while (end < length && path[end] != '/') ++end;
        size_t n = end - start;
        if (n == 0 || n > NAME_MAX ||
            (n == 1 && path[start] == '.') ||
            (n == 2 && path[start] == '.' && path[start + 1] == '.') ||
            ++depth > PIPE_MAX_DEPTH) return false;
        for (size_t i = start; i < end; ++i)
            if ((unsigned char)path[i] < 0x20 || path[i] == 0x7f) return false;
        start = end + 1;
    }
    return depth > 0;
}

/* Return with the checked parent descriptor still held. */
static enum pipe_proof pipe_parent(const char *path, int *out)
{
    int parent = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) return PIPE_UNKNOWN;
    enum pipe_proof proof = pipe_protected_fd(parent, true);
    for (size_t start = 1; proof == PIPE_OK && path[start] != '\0';) {
        size_t end = start;
        while (path[end] != '\0' && path[end] != '/') ++end;
        char name[NAME_MAX + 1];
        size_t n = end - start;
        if (n == 0 || n > NAME_MAX) {
            proof = PIPE_UNKNOWN;
            break;
        }
        memcpy(name, path + start, n);
        name[n] = '\0';
        struct stat before;
        if (fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
            proof = PIPE_UNKNOWN;
            break;
        }
        if (!S_ISDIR(before.st_mode)) {
            proof = PIPE_REFUSED;
            break;
        }
        int child = openat(parent, name, O_RDONLY | O_DIRECTORY |
                           O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
        if (child < 0) {
            proof = errno == ELOOP ? PIPE_REFUSED : PIPE_UNKNOWN;
            break;
        }
        struct stat after;
        if (fstat(child, &after) != 0 || before.st_dev != after.st_dev ||
            before.st_ino != after.st_ino ||
            (before.st_mode & S_IFMT) != (after.st_mode & S_IFMT))
            proof = PIPE_UNKNOWN;
        if (proof == PIPE_OK) proof = pipe_protected_fd(child, true);
        if (proof != PIPE_OK) {
            close(child);
            break;
        }
        close(parent);
        parent = child;
        if (path[end] == '\0') break;
        start = end + 1;
    }
    if (proof != PIPE_OK) close(parent);
    else *out = parent;
    return proof;
}

static bool pipe_same_file(const struct stat *a, const struct stat *b)
{
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
        (a->st_mode & S_IFMT) == (b->st_mode & S_IFMT);
}

static bool pipe_hash_fd(int fd, uint64_t size, uint8_t digest[32])
{
    CC_SHA256_CTX ctx;
    if (CC_SHA256_Init(&ctx) != 1) return false;
    uint8_t bytes[PIPE_CHUNK];
    uint64_t pos = 0;
    while (pos < size) {
        size_t want = size - pos < sizeof(bytes) ? (size_t)(size - pos) : sizeof(bytes);
        ssize_t n = pread(fd, bytes, want, (off_t)pos);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0 || CC_SHA256_Update(&ctx, bytes, (CC_LONG)n) != 1)
            return false;
        pos += (uint64_t)n;
    }
    return CC_SHA256_Final(digest, &ctx) == 1;
}

static bool pipe_copy(int source, int dest, uint64_t size, uint8_t digest[32])
{
    CC_SHA256_CTX ctx;
    if (CC_SHA256_Init(&ctx) != 1) return false;
    uint8_t bytes[PIPE_CHUNK];
    uint64_t pos = 0;
    while (pos < size) {
        size_t want = size - pos < sizeof(bytes) ? (size_t)(size - pos) : sizeof(bytes);
        ssize_t n = pread(source, bytes, want, (off_t)pos);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0 || CC_SHA256_Update(&ctx, bytes, (CC_LONG)n) != 1)
            return false;
        size_t done = 0;
        while (done < (size_t)n) {
            ssize_t written = pwrite(dest, bytes + done, (size_t)n - done,
                                     (off_t)(pos + done));
            if (written < 0 && errno == EINTR) continue;
            if (written <= 0) return false;
            done += (size_t)written;
        }
        pos += (uint64_t)n;
    }
    return CC_SHA256_Final(digest, &ctx) == 1;
}

static int pipe_report(int fd, enum pipe_proof proof, const char *reason)
{
    const char *state = proof == PIPE_OK ? "admitted" :
                        proof == PIPE_REFUSED ? "refused" : "uncertain";
    char message[128];
    int length = snprintf(message, sizeof(message),
                          "{\"state\":\"%s\",\"reason\":\"%s\"}\n", state, reason);
    if (length < 0 || (size_t)length >= sizeof(message)) return PIPE_UNKNOWN;
    size_t done = 0;
    while (done < (size_t)length) {
        ssize_t n = write(fd, message + done, (size_t)length - done);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return PIPE_UNKNOWN;
        done += (size_t)n;
    }
    return proof;
}

/* The caller must ignore or block SIGPIPE if report_fd may be a pipe. */
int pipe_admit_artifact(int source_fd, uint64_t exact_size,
                        const uint8_t independent_sha256[32],
                        const char *protected_parent, const char *fresh_stage_name,
                        int report_fd)
{
    if (source_fd < 0 || report_fd < 0 || source_fd == report_fd ||
        independent_sha256 == NULL || exact_size > INT64_MAX)
        return pipe_report(report_fd, PIPE_REFUSED, "invalid_input");
    if (!pipe_stage_name(fresh_stage_name))
        return pipe_report(report_fd, PIPE_REFUSED, "invalid_stage_name");
    if (!pipe_path(protected_parent))
        return pipe_report(report_fd, PIPE_REFUSED, "invalid_parent_path");
    if (exact_size > PIPE_MAX_ARTIFACT)
        return pipe_report(report_fd, PIPE_REFUSED, "size_bound");

    struct stat source_before;
    if (fstat(source_fd, &source_before) != 0)
        return pipe_report(report_fd, PIPE_UNKNOWN, "source_stat");
    if (!S_ISREG(source_before.st_mode) || source_before.st_size < 0 ||
        (uint64_t)source_before.st_size != exact_size)
        return pipe_report(report_fd, PIPE_REFUSED, "source_size");

    uint8_t source_digest[32];
    if (!pipe_hash_fd(source_fd, exact_size, source_digest))
        return pipe_report(report_fd, PIPE_UNKNOWN, "source_read");
    struct stat source_after;
    if (fstat(source_fd, &source_after) != 0 ||
        !pipe_same_file(&source_before, &source_after) ||
        source_after.st_size != source_before.st_size)
        return pipe_report(report_fd, PIPE_UNKNOWN, "source_changed");
    if (memcmp(source_digest, independent_sha256, 32) != 0)
        return pipe_report(report_fd, PIPE_REFUSED, "pin_mismatch");

    int parent = -1;
    enum pipe_proof proof = pipe_parent(protected_parent, &parent);
    if (proof != PIPE_OK)
        return pipe_report(report_fd, proof, "parent_proof");
    proof = pipe_private_parent(parent);
    if (proof != PIPE_OK) {
        close(parent);
        return pipe_report(report_fd, proof, "stage_parent_private");
    }
    struct stat parent_st;
    if (fstat(parent, &parent_st) != 0) {
        close(parent);
        return pipe_report(report_fd, PIPE_UNKNOWN, "parent_stat");
    }

    int dest = openat(parent, fresh_stage_name, O_RDWR | O_CREAT | O_EXCL |
                      O_NOFOLLOW | O_CLOEXEC, 0400);
    if (dest < 0) {
        int result = pipe_report(report_fd,
            errno == EEXIST || errno == ELOOP ? PIPE_REFUSED : PIPE_UNKNOWN,
            errno == EEXIST || errno == ELOOP ? "stage_exists" : "stage_create");
        close(parent);
        return result;
    }

    const char *reason = "ok";
    uint8_t copied_digest[32], dest_digest[32];
    struct stat dest_st, named_st;
    int rewalk = -1;
    struct stat rewalk_st, rewalk_named;
    if (!pipe_copy(source_fd, dest, exact_size, copied_digest))
        reason = "copy_failed";
    else if (memcmp(copied_digest, independent_sha256, 32) != 0)
        reason = "source_changed";
    else if (fstat(source_fd, &source_after) != 0 ||
             !pipe_same_file(&source_before, &source_after) ||
             source_after.st_size != source_before.st_size)
        reason = "source_changed";
    else if (!pipe_hash_fd(dest, exact_size, dest_digest))
        reason = "destination_read";
    else if (memcmp(dest_digest, independent_sha256, 32) != 0)
        reason = "destination_digest";
    else if (fstat(dest, &dest_st) != 0 || !S_ISREG(dest_st.st_mode) ||
             dest_st.st_size < 0 || (uint64_t)dest_st.st_size != exact_size ||
             (dest_st.st_mode & 0777) != 0400 || dest_st.st_nlink != 1)
        reason = "destination_stat";
    else if (pipe_protected_fd(dest, false) != PIPE_OK)
        reason = "destination_proof";
    else if (fstatat(parent, fresh_stage_name, &named_st, AT_SYMLINK_NOFOLLOW) != 0 ||
             !pipe_same_file(&dest_st, &named_st))
        reason = "destination_identity";
    else if (pipe_private_parent(parent) != PIPE_OK)
        reason = "parent_changed";
    else if (pipe_parent(protected_parent, &rewalk) != PIPE_OK)
        reason = "parent_rewalk";
    else if (pipe_private_parent(rewalk) != PIPE_OK)
        reason = "parent_rewalk";
    else if (fstat(rewalk, &rewalk_st) != 0 ||
             !pipe_same_file(&parent_st, &rewalk_st) ||
             fstatat(rewalk, fresh_stage_name, &rewalk_named, AT_SYMLINK_NOFOLLOW) != 0 ||
             !pipe_same_file(&dest_st, &rewalk_named))
        reason = "parent_detached";
    else if (fsync(dest) != 0)
        reason = "file_sync";
    else if (fsync(parent) != 0)
        reason = "parent_sync";

    /* A created file is never unlinked on an uncertain outcome. */
    if (rewalk >= 0) close(rewalk);
    close(dest);
    close(parent);
    return pipe_report(report_fd, strcmp(reason, "ok") == 0 ? PIPE_OK : PIPE_UNKNOWN,
                       reason);
}
