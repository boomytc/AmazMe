#import <Cocoa/Cocoa.h>
#import <unistd.h>
static NSString *statePath;
@interface SmokeDelegate : NSObject <NSApplicationDelegate>
@property NSWindow *window;
@property NSTextField *counterLabel;
@property NSTextField *input;
@property NSInteger nativeCount;
@property NSInteger canvasCount;
@property NSInteger rightCount;
@property NSInteger dragCount;
@property double scrollTotal;
@property NSPoint lastCanvasPoint;
@property NSPoint lastDragPoint;
- (void)save;
- (void)increment:(id)sender;
@end
@interface Canvas : NSView
@property (weak) SmokeDelegate *owner;
@end
@implementation Canvas
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)isAccessibilityElement { return NO; }
- (NSArray *)accessibilityChildren { return @[]; }
- (void)drawRect:(NSRect)dirty {
  [[NSColor colorWithSRGBRed:0.08 green:0.25 blue:0.60 alpha:1] setFill];
  [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:12 yRadius:12] fill];
  NSDictionary *attrs=@{NSFontAttributeName:[NSFont boldSystemFontOfSize:24],NSForegroundColorAttributeName:NSColor.whiteColor};
  [@"Increment Canvas" drawAtPoint:NSMakePoint(28,88) withAttributes:attrs];
  [[NSString stringWithFormat:@"Canvas Counter: %ld",(long)self.owner.canvasCount] drawAtPoint:NSMakePoint(28,40) withAttributes:attrs];
}
- (void)mouseDown:(NSEvent *)event { self.owner.canvasCount++; self.owner.lastCanvasPoint=[self convertPoint:event.locationInWindow fromView:nil]; [self.owner save]; [self setNeedsDisplay:YES]; }
- (void)rightMouseDown:(NSEvent *)event { self.owner.rightCount++; [self.owner save]; }
- (void)mouseDragged:(NSEvent *)event { self.owner.dragCount++; self.owner.lastDragPoint=[self convertPoint:event.locationInWindow fromView:nil]; [self.owner save]; }
- (void)scrollWheel:(NSEvent *)event { self.owner.scrollTotal += event.scrollingDeltaY; [self.owner save]; }
@end
@implementation SmokeDelegate
- (void)save {
 CGEventRef event=CGEventCreate(NULL); CGPoint pointer=CGEventGetLocation(event); CFRelease(event);
 NSDictionary *state=@{@"pid":@(getpid()),@"windowId":@(self.window.windowNumber),@"nativeCount":@(self.nativeCount),@"canvasCount":@(self.canvasCount),@"rightCount":@(self.rightCount),@"dragCount":@(self.dragCount),@"scrollTotal":@(self.scrollTotal),@"canvasX":@(self.lastCanvasPoint.x),@"dragX":@(self.lastDragPoint.x),@"dragY":@(self.lastDragPoint.y),@"canvasY":@(self.lastCanvasPoint.y),@"text":self.input.stringValue?:@"",@"frontmostPid":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),@"pointerX":@(pointer.x),@"pointerY":@(pointer.y),@"keyWindow":@(self.window.isKeyWindow)};
 [[NSJSONSerialization dataWithJSONObject:state options:NSJSONWritingPrettyPrinted error:nil] writeToFile:statePath atomically:YES];
}
- (void)increment:(id)sender { self.nativeCount++; self.counterLabel.stringValue=[NSString stringWithFormat:@"Native Counter: %ld",(long)self.nativeCount]; [self save]; }
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
 self.window=[[NSWindow alloc] initWithContentRect:NSMakeRect(200,220,740,460) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
 self.window.title=@"AmazMe Computer Use Smoke";
 NSView *content=self.window.contentView;
 NSTextField *heading=[NSTextField labelWithString:@"AmazMe Desktop Integration Fixture"];
 heading.font=[NSFont boldSystemFontOfSize:26]; heading.frame=NSMakeRect(30,390,680,40); [content addSubview:heading];
 self.counterLabel=[NSTextField labelWithString:@"Native Counter: 0"]; self.counterLabel.font=[NSFont systemFontOfSize:24]; self.counterLabel.frame=NSMakeRect(30,335,320,40); [content addSubview:self.counterLabel];
 NSButton *button=[NSButton buttonWithTitle:@"Increment Native" target:self action:@selector(increment:)]; button.frame=NSMakeRect(30,260,270,54); button.bezelStyle=NSBezelStyleRounded; button.font=[NSFont systemFontOfSize:22]; [content addSubview:button];
 NSTextField *inputLabel=[NSTextField labelWithString:@"Smoke Input"]; inputLabel.frame=NSMakeRect(30,205,270,24); [content addSubview:inputLabel];
 self.input=[[NSTextField alloc] initWithFrame:NSMakeRect(30,160,280,36)]; self.input.placeholderString=@"Smoke Input"; self.input.accessibilityLabel=@"Smoke Input"; [content addSubview:self.input];
 Canvas *canvas=[[Canvas alloc] initWithFrame:NSMakeRect(370,160,330,160)]; canvas.owner=self; [content addSubview:canvas];
 NSTextField *footer=[NSTextField labelWithString:@"Temporary reversible test controls. No external data or network."]; footer.frame=NSMakeRect(30,50,680,30); [content addSubview:footer];
 [self.window orderFrontRegardless];
 [self save];
 [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *timer){ [self save]; }];
}
@end
int main(int argc,const char *argv[]) { @autoreleasepool {
 if(argc==2 && !strcmp(argv[1],"--probe")) {
  CGEventRef event=CGEventCreate(NULL); CGPoint point=CGEventGetLocation(event); CFRelease(event);
  NSDictionary *state=@{@"frontmostPid":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),@"pointerX":@(point.x),@"pointerY":@(point.y)};
  puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:state options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String); return 0;
 }
 if(argc==3 && !strcmp(argv[1],"--activate")) { [[NSRunningApplication runningApplicationWithProcessIdentifier:atoi(argv[2])] activateWithOptions:0]; return 0; }
 if(argc!=2) return 64;
 statePath=[NSString stringWithUTF8String:argv[1]];
 [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
 SmokeDelegate *delegate=[SmokeDelegate new]; NSApp.delegate=delegate; [NSApp run];
} return 0; }
