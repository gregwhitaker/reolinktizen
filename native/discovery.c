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
static unsigned char packet[65536];
static char sender[INET_ADDRSTRLEN];

void discovery_close(void) {
  if (discovery_fd >= 0) close(discovery_fd);
  discovery_fd = -1;
}

int discovery_open(void) {
  discovery_close();
#ifdef __EMSCRIPTEN__
  discovery_fd = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK, 0);
#else
  discovery_fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (discovery_fd >= 0 && fcntl(discovery_fd, F_SETFL, O_NONBLOCK) < 0) {
    discovery_close(); return -1;
  }
#endif
  if (discovery_fd < 0) return -1;
  struct sockaddr_in local;
  memset(&local, 0, sizeof(local));
  local.sin_family = AF_INET;
  local.sin_addr.s_addr = htonl(INADDR_ANY);
  int ttl = 1;
  if (setsockopt(discovery_fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl)) < 0 ||
      bind(discovery_fd, (struct sockaddr *)&local, sizeof(local)) < 0) {
    discovery_close(); return -1;
  }
  return 0;
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

int discovery_receive(void) {
  if (discovery_fd < 0) return -1;
  struct sockaddr_in peer;
  socklen_t length = sizeof(peer);
  int count = (int)recvfrom(discovery_fd, packet, sizeof(packet), 0,
    (struct sockaddr *)&peer, &length);
  /* Samsung's SDK uses WASI errno constants, including its own EAGAIN value. */
  if (count < 0) {
#ifdef __WASI_ERRNO_AGAIN
    if (errno == __WASI_ERRNO_AGAIN) return 0;
#endif
    return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR ? 0 : -1;
  }
  if (peer.sin_family != AF_INET || !inet_ntop(AF_INET, &peer.sin_addr, sender, sizeof(sender))) return 0;
  return count;
}
