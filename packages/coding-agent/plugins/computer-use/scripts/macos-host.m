#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <unistd.h>
#include <errno.h>

// This accessory app owns TCC identity and one embedded service's stdin lifetime.
// The MCP proxy connects to a caller-owned private socket; this host has no API listener.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
	if (argc == 2 && !strcmp(argv[1], "check-permissions")) {
	  NSDictionary *permissions = @{@"accessibility": AXIsProcessTrusted() ? @YES : @NO,
	    @"screen_recording": CGPreflightScreenCaptureAccess() ? @YES : @NO,
	    @"host_bundle_id": NSBundle.mainBundle.bundleIdentifier ?: @""};
	  NSData *data = [NSJSONSerialization dataWithJSONObject:permissions options:0 error:nil];
	  [NSFileHandle.fileHandleWithStandardOutput writeData:data];
	  return 0;
	}
    if (argc != 4 || strcmp(argv[1], "serve") || strcmp(argv[2], "--socket") || argv[3][0] != '/') return 64;
    NSBundle *bundle = NSBundle.mainBundle;
    if (!bundle.bundleIdentifier) return 64;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSTask *service = [NSTask new];
    service.executableURL = [NSURL fileURLWithPath:[bundle.bundlePath stringByAppendingPathComponent:@"Contents/MacOS/cua-driver"]];
    service.arguments = @[@"serve", @"--embedded", @"--socket", [NSString stringWithUTF8String:argv[3]],
      @"--host-bundle-id", bundle.bundleIdentifier, @"--parent-liveness-stdio", @"--permission-mode", @"standard"];
    NSMutableDictionary *environment = [NSMutableDictionary new];
    NSSet *allowed = [NSSet setWithArray:@[@"PATH", @"HOME", @"USER", @"LOGNAME", @"SHELL", @"TMPDIR", @"LANG"]];
    [NSProcessInfo.processInfo.environment enumerateKeysAndObjectsUsingBlock:^(NSString *key, NSString *value, BOOL *stop) {
      if ([allowed containsObject:key] || [key hasPrefix:@"LC_"]) environment[key] = value;
    }];
    environment[@"CUA_DRIVER_RS_TELEMETRY_ENABLED"] = @"false";
    environment[@"CUA_TELEMETRY_ENABLED"] = @"false";
    service.environment = environment;
    NSPipe *lifetime = [NSPipe pipe];
    service.standardInput = lifetime.fileHandleForReading;
    service.standardOutput = NSFileHandle.fileHandleWithStandardOutput;
    service.standardError = NSFileHandle.fileHandleWithStandardError;
    service.terminationHandler = ^(NSTask *finished) {
      dispatch_async(dispatch_get_main_queue(), ^{ exit(finished.terminationStatus); });
    };
    NSError *failure = nil;
    if (![service launchAndReturnError:&failure]) {
      fprintf(stderr, "%s\n", failure.localizedDescription.UTF8String);
      return 70;
    }
    [lifetime.fileHandleForReading closeFile];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      char data[64];
      ssize_t count;
      do { count = read(STDIN_FILENO, data, sizeof(data)); } while (count > 0 || (count < 0 && errno == EINTR));
      [lifetime.fileHandleForWriting closeFile];
    });
    [NSApp run];
    return 0;
  }
}
