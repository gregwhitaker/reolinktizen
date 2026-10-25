/* Small UDP boundary for Samsung's Emscripten / Tizen Sockets Extension.
 * All calls run in a dedicated Web Worker. No credentials or HTTP requests.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#ifdef __EMSCRIPTEN__
#include <wasi/api.h>
#else
#include <fcntl.h>
#endif

static int discovery_fd = -1;
static int reolink_fd = -1;
static unsigned int next_socket;
static unsigned char packet[65536];
static char sender[INET_ADDRSTRLEN];

void discovery_close(void) {
  if (discovery_fd >= 0) close(discovery_fd);
  if (reolink_fd >= 0) close(reolink_fd);
  discovery_fd = -1;
  reolink_fd = -1;
}

static int open_socket(int port) {
  int fd;
#ifdef __EMSCRIPTEN__
  fd = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK, 0);
#else
  fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd >= 0 && fcntl(fd, F_SETFL, O_NONBLOCK) < 0) {
    int failure = errno; close(fd); errno = failure; return -1;
  }
#endif
  if (fd < 0) return -1;
  struct sockaddr_in local;
  memset(&local, 0, sizeof(local));
  local.sin_family = AF_INET;
  local.sin_addr.s_addr = htonl(INADDR_ANY);
  local.sin_port = htons((uint16_t)port);
  int enabled = 1;
  if (port) setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));
  if ((port && setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &enabled, sizeof(enabled)) < 0) ||
      setsockopt(fd, IPPROTO_IP, port ? IP_TTL : IP_MULTICAST_TTL, &enabled, sizeof(enabled)) < 0 ||
      bind(fd, (struct sockaddr *)&local, sizeof(local)) < 0) {
    int failure = errno; close(fd); errno = failure; return -1;
  }
  return fd;
}

int discovery_open(void) {
  discovery_close();
  next_socket = 0;
  discovery_fd = open_socket(0);
  reolink_fd = open_socket(3000);
  /* Bits: ONVIF available, Reolink available, Reolink reply port occupied. */
  int busy = reolink_fd < 0 && errno == EADDRINUSE;
#ifdef __WASI_ERRNO_ADDRINUSE
  if (reolink_fd < 0 && errno == __WASI_ERRNO_ADDRINUSE) busy = 1;
#endif
  return (discovery_fd >= 0 ? 1 : 0) | (reolink_fd >= 0 ? 2 : 0) | (busy ? 4 : 0);
}

unsigned char *discovery_buffer(void) { return packet; }
const char *discovery_sender(void) { return sender; }

int discovery_send(int length) {
  if (discovery_fd < 0 || length < 1 || length > 4096) return -1;
  struct sockaddr_in destination;
  memset(&destination, 0, sizeof(destination));
  destination.sin_family = AF_INET;
  destination.sin_port = htons(3702);
  inet_pton(AF_INET, "239.255.255.250", &destination.sin_addr);
  return (int)sendto(discovery_fd, packet, (size_t)length, 0,
    (struct sockaddr *)&destination, sizeof(destination));
}

int discovery_send_reolink(void) {
  if (reolink_fd < 0) return -1;
  static const unsigned char probe[] = { 0xaa, 0xaa, 0, 0 };
  struct sockaddr_in destination;
  memset(&destination, 0, sizeof(destination));
  destination.sin_family = AF_INET;
  destination.sin_port = htons(2000);
  destination.sin_addr.s_addr = htonl(INADDR_BROADCAST);
  return (int)sendto(reolink_fd, probe, sizeof(probe), 0,
    (struct sockaddr *)&destination, sizeof(destination));
}

int discovery_receive(void) {
  if (discovery_fd < 0 && reolink_fd < 0) return -1;
  for (int attempt = 0; attempt < 2; attempt++) {
    int *fd = next_socket++ % 2 ? &reolink_fd : &discovery_fd;
    if (*fd < 0) continue;
    struct sockaddr_in peer;
    socklen_t length = sizeof(peer);
    int count = (int)recvfrom(*fd, packet, sizeof(packet), 0,
      (struct sockaddr *)&peer, &length);
    /* Samsung's SDK also uses its own WASI EAGAIN value. */
    if (count < 0) {
#ifdef __WASI_ERRNO_AGAIN
      if (errno == __WASI_ERRNO_AGAIN) continue;
#endif
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
      close(*fd); *fd = -1;
      if (discovery_fd < 0 && reolink_fd < 0) return -1;
      continue;
    }
    if (peer.sin_family == AF_INET && inet_ntop(AF_INET, &peer.sin_addr, sender, sizeof(sender))) return count;
  }
  return 0;
}
