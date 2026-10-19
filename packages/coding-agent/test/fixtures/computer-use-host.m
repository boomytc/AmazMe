#import <Cocoa/Cocoa.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static NSString *root;
static void logEvent(NSDictionary *event) {
  NSString *path = [root stringByAppendingPathComponent:@"events.jsonl"];
  if (![[NSFileManager defaultManager] fileExistsAtPath:path])
    [[NSData data] writeToFile:path atomically:NO];
  NSFileHandle *file = [NSFileHandle fileHandleForWritingAtPath:path];
  [file seekToEndOfFile];
  [file writeData:[NSJSONSerialization dataWithJSONObject:event options:0 error:nil]];
  [file writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
  [file closeFile];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    root = [NSBundle.mainBundle.bundlePath stringByAppendingPathComponent:@"Contents/MacOS"];
    if (argc >= 2 && !strcmp(argv[1], "mcp")) {
      NSString *node = [NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@"node-path.txt"] encoding:NSUTF8StringEncoding error:nil];
      char **arguments = calloc(argc + 2, sizeof(char *));
      arguments[0] = (char *)node.UTF8String;
      arguments[1] = (char *)[root stringByAppendingPathComponent:@"driver-fixture.mjs"].UTF8String;
      for (int i = 1; i < argc; i++) arguments[i + 1] = (char *)argv[i];
      execv(arguments[0], arguments);
      return 70;
    }
    if (argc >= 3 && !strcmp(argv[1], "serve") && !strcmp(argv[2], "--embedded")) {
      logEvent(@{@"event": @"service-started", @"pid": @(getpid())});
      // Deliberately ignore EOF, as a deadlocked service might. The parent must still reclaim this process.
      for (;;) pause();
    }
    if (argc == 2 && !strcmp(argv[1], "check-permissions")) {
      logEvent(@{@"event": @"probe", @"pid": @(getpid())});
      NSString *mode = [NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@"mode.txt"] encoding:NSUTF8StringEncoding error:nil];
      if ([mode hasPrefix:@"hung-probe"]) {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp finishLaunching];
        [NSApp run];
        return 0;
      }
      puts("{\"accessibility\":false,\"screen_recording\":false}");
      return 0;
    }
    if (argc != 4 || strcmp(argv[1], "serve") || strcmp(argv[2], "--socket")) return 64;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    int server = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    strlcpy(address.sun_path, argv[3], sizeof(address.sun_path));
    if (bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 1)) return 70;
    NSString *endpoint = [NSString stringWithUTF8String:argv[3]];
    NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:endpoint.stringByDeletingLastPathComponent error:nil];
    logEvent(@{@"event": @"host-started", @"socket": endpoint, @"pid": @(getpid()),
      @"directoryMode": attributes[NSFilePosixPermissions]});
    NSString *mode = [NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@"mode.txt"] encoding:NSUTF8StringEncoding error:nil];
    NSPipe *lifetime = [NSPipe pipe];
    if ([mode isEqualToString:@"hung-service"]) {
      NSTask *service = [NSTask new];
      service.executableURL = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"cua-driver"]];
      service.arguments = @[@"serve", @"--embedded", @"--socket", endpoint, @"--host-bundle-id", @"com.amazme.computer-use", @"--parent-liveness-stdio", @"--permission-mode", @"standard"];
      service.standardInput = lifetime.fileHandleForReading;
      service.terminationHandler = ^(NSTask *finished) { logEvent(@{@"event": @"host-exited"}); exit(0); };
      if (![service launchAndReturnError:nil]) return 70;
      [lifetime.fileHandleForReading closeFile];
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      char data[64];
      ssize_t count;
      do { count = read(STDIN_FILENO, data, sizeof(data)); } while (count > 0 || (count < 0 && errno == EINTR));
      NSString *mode = [NSString stringWithContentsOfFile:[root stringByAppendingPathComponent:@"mode.txt"] encoding:NSUTF8StringEncoding error:nil];
      if ([mode isEqualToString:@"hung-host"]) return;
      if ([mode isEqualToString:@"hung-service"]) { [lifetime.fileHandleForWriting closeFile]; return; }
      logEvent(@{@"event": @"host-exited"});
      close(server);
      exit(0);
    });
    [NSApp run];
  }
  return 0;
}
