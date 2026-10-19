// A separate UI-only application. It never captures the desktop or owns its grants.
export const permissionPanelSource = String.raw`
#import <Cocoa/Cocoa.h>
#include <unistd.h>

static void sendEvent(NSString *event) {
  puts([[@"{\"event\":\"" stringByAppendingString:[event stringByAppendingString:@"\"}"]] UTF8String]);
  fflush(stdout);
}
static NSTextField *label(NSString *text, CGFloat size, NSFontWeight weight) {
  NSTextField *view = [NSTextField labelWithString:text];
  view.font = [NSFont systemFontOfSize:size weight:weight];
  return view;
}
@interface PermissionCard : NSStackView
@end
@implementation PermissionCard
- (BOOL)wantsUpdateLayer { return YES; }
- (void)updateLayer {
  [self.effectiveAppearance performAsCurrentDrawingAppearance:^{
    self.layer.backgroundColor=NSColor.controlBackgroundColor.CGColor;
    self.layer.borderColor=NSColor.separatorColor.CGColor;
  }];
}
- (void)viewDidChangeEffectiveAppearance {
  [super viewDidChangeEffectiveAppearance]; self.needsDisplay=YES;
}
@end
@interface PermissionPanel : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property (strong) NSWindow *window;
@property (strong) NSDictionary *report;
@property (strong) NSMutableDictionary<NSString *, NSTextField *> *states;
@property (strong) NSMutableDictionary<NSString *, NSView *> *badges;
@property (strong) NSMutableDictionary<NSString *, NSImageView *> *icons;
@property (strong) NSTextField *summary;
@property (strong) NSTextField *path;
@property (strong) NSButton *recheck;
@property (strong) NSButton *done;
@property (strong) NSButton *later;
@property (strong) NSMutableDictionary<NSString *, NSButton *> *settings;
@property BOOL checking;
@end
@implementation PermissionPanel
- (void)requestCheck:(id)sender {
  if (self.checking) return;
  self.checking = YES;
  self.recheck.enabled = NO;
  self.recheck.title = @"正在检查…";
  sendEvent(@"recheck");
}
- (void)openAccessibility:(id)sender { [self openPane:@"Privacy_Accessibility"]; }
- (void)openScreen:(id)sender { [self openPane:@"Privacy_ScreenCapture"]; }
- (void)openPane:(NSString *)pane {
  NSURL *url = [NSURL URLWithString:[@"x-apple.systempreferences:com.apple.preference.security?" stringByAppendingString:pane]];
  if (![NSWorkspace.sharedWorkspace openURL:url]) {
    self.summary.stringValue = @"请手动打开“系统设置 → 隐私与安全性”完成授权。";
  }
}
- (void)later:(id)sender { [NSApp terminate:nil]; }
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app { return YES; }
- (void)applicationDidBecomeActive:(NSNotification *)notification {
  if (self.window) [self requestCheck:nil];
}
- (void)applyReport:(NSDictionary *)report {
  self.report = report;
  self.checking = NO;
  self.recheck.enabled = YES;
  self.recheck.title = @"重新检查";
  BOOL allReady = [report[@"status"] isEqual:@"ready"];
  self.done.hidden = !allReady; self.later.hidden = allReady;
  self.recheck.keyEquivalent = allReady ? @"" : @"\r";
  self.done.keyEquivalent = allReady ? @"\r" : @"";
  BOOL known = [report[@"status"] isEqual:@"ready"] || [report[@"status"] isEqual:@"permission_required"];
  NSArray *missing = report[@"missing"];
  for (NSString *key in self.states) {
    BOOL granted = known && ![missing containsObject:key];
    NSTextField *state = self.states[key];
    NSColor *color = granted ? NSColor.systemGreenColor : known ? NSColor.systemOrangeColor : NSColor.secondaryLabelColor;
    state.stringValue = granted ? @"已授权" : known ? @"待授权" : @"待检查";
    state.textColor = color;
    self.badges[key].layer.backgroundColor = [color colorWithAlphaComponent:0.12].CGColor;
    self.settings[key].title = granted ? @"查看设置" : @"前往设置";
    NSImageView *icon = self.icons[key];
    icon.image = [NSImage imageWithSystemSymbolName:granted ? @"checkmark.circle.fill" : @"exclamationmark.circle.fill" accessibilityDescription:state.stringValue];
    icon.contentTintColor = color;
  }
  self.summary.stringValue = [report[@"status"] isEqual:@"ready"]
    ? @"权限已就绪。关闭此窗口后，重新观察目标并发起新操作。"
    : known ? @"请完成待授权项目；未看到应用时，可用系统设置中的“＋”添加下方应用。"
    : @"暂时无法读取权限，请重试检查或确认运行时仍可用。";
  NSString *path = report[@"host_path"];
  self.path.stringValue = [path isKindOfClass:NSString.class] ? path : @"请确认实际运行时应用";
  self.path.toolTip = self.path.stringValue;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.states = [NSMutableDictionary new]; self.badges = [NSMutableDictionary new];
  self.icons = [NSMutableDictionary new]; self.settings = [NSMutableDictionary new];
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,700,490)
    styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"AmazMe · 桌面权限";
  self.window.delegate = self; self.window.releasedWhenClosed = NO;
  self.window.titlebarAppearsTransparent = YES;
  self.window.contentMinSize = NSMakeSize(660,490);
  self.window.contentMaxSize = NSMakeSize(900,650);
  self.window.collectionBehavior = NSWindowCollectionBehaviorFullScreenNone;
  NSView *content = self.window.contentView;
  NSStackView *root = [NSStackView new]; root.orientation=NSUserInterfaceLayoutOrientationVertical;
  root.alignment=NSLayoutAttributeLeading; root.spacing=20; root.translatesAutoresizingMaskIntoConstraints=NO;
  [content addSubview:root];
  [NSLayoutConstraint activateConstraints:@[
    [root.leadingAnchor constraintEqualToAnchor:content.leadingAnchor constant:28],
    [root.trailingAnchor constraintEqualToAnchor:content.trailingAnchor constant:-28],
    [root.topAnchor constraintEqualToAnchor:content.topAnchor constant:24],
    [root.bottomAnchor constraintEqualToAnchor:content.bottomAnchor constant:-24]
  ]];
  NSStackView *header=[NSStackView new]; header.orientation=NSUserInterfaceLayoutOrientationVertical;
  header.alignment=NSLayoutAttributeLeading; header.spacing=7;
  [header addArrangedSubview:label(@"桌面访问权限",24,NSFontWeightSemibold)];
  NSTextField *subtitle=label(@"按需授权，让 AmazMe 在后台观察和操作目标窗口。",13,NSFontWeightRegular);
  subtitle.textColor=NSColor.secondaryLabelColor; [header addArrangedSubview:subtitle]; [root addArrangedSubview:header];
  NSStackView *rows=[NSStackView new]; rows.orientation=NSUserInterfaceLayoutOrientationVertical;
  rows.alignment=NSLayoutAttributeLeading; rows.spacing=12; [root addArrangedSubview:rows];
  NSArray *keys=@[@"accessibility",@"screen_recording"];
  NSArray *titles=@[@"辅助功能",@"屏幕录制"];
  NSArray *details=@[@"识别控件与执行操作 · 设备控制和数据访问",@"观察目标窗口 · 录屏与系统录音"];
  for (NSUInteger index=0; index<keys.count; index++) {
    NSString *key=keys[index];
    NSStackView *row=[PermissionCard new]; row.orientation=NSUserInterfaceLayoutOrientationHorizontal;
    row.distribution=NSStackViewDistributionFill;
    row.alignment=NSLayoutAttributeCenterY; row.spacing=16; row.edgeInsets=(NSEdgeInsets){16,16,16,16};
    row.wantsLayer=YES; row.layer.cornerRadius=12; row.layer.borderWidth=1;
    NSImageView *icon=[NSImageView new]; icon.imageScaling=NSImageScaleProportionallyUpOrDown;
    self.icons[key]=icon; [row addArrangedSubview:icon];
    NSStackView *words=[NSStackView new]; words.orientation=NSUserInterfaceLayoutOrientationVertical;
    words.alignment=NSLayoutAttributeLeading; words.spacing=5;
    [words addArrangedSubview:label(titles[index],15,NSFontWeightSemibold)];
    NSTextField *detail=label(details[index],11,NSFontWeightRegular); detail.textColor=NSColor.secondaryLabelColor;
    detail.lineBreakMode=NSLineBreakByWordWrapping; detail.maximumNumberOfLines=2; [words addArrangedSubview:detail];
    [words setContentHuggingPriority:100 forOrientation:NSLayoutConstraintOrientationHorizontal];
    [row addArrangedSubview:words];
    NSTextField *state=label(@"待检查",12,NSFontWeightMedium); state.alignment=NSTextAlignmentCenter;
    NSView *badge=[NSView new]; badge.wantsLayer=YES; badge.layer.cornerRadius=7;
    state.translatesAutoresizingMaskIntoConstraints=NO; [badge addSubview:state];
    self.states[key]=state; self.badges[key]=badge; [row addArrangedSubview:badge];
    NSButton *settings=[NSButton buttonWithTitle:@"前往设置" target:self action:index==0 ? @selector(openAccessibility:) : @selector(openScreen:)];
    settings.bezelStyle=NSBezelStyleRounded; settings.accessibilityLabel=index==0 ? @"打开辅助功能设置" : @"打开屏幕录制设置";
    self.settings[key]=settings; [row addArrangedSubview:settings]; [rows addArrangedSubview:row];
    [NSLayoutConstraint activateConstraints:@[
      [row.widthAnchor constraintEqualToAnchor:rows.widthAnchor], [row.heightAnchor constraintGreaterThanOrEqualToConstant:82],
      [icon.widthAnchor constraintEqualToConstant:24], [icon.heightAnchor constraintEqualToConstant:24],
      [badge.widthAnchor constraintEqualToConstant:76], [badge.heightAnchor constraintEqualToConstant:26],
      [state.centerXAnchor constraintEqualToAnchor:badge.centerXAnchor], [state.centerYAnchor constraintEqualToAnchor:badge.centerYAnchor],
      [settings.widthAnchor constraintEqualToConstant:104], [settings.trailingAnchor constraintEqualToAnchor:row.trailingAnchor constant:-16]
    ]];
  }
  NSStackView *identity=[NSStackView new]; identity.orientation=NSUserInterfaceLayoutOrientationVertical;
  identity.alignment=NSLayoutAttributeLeading; identity.spacing=6;
  [identity addArrangedSubview:label(@"授权对象 · AmazMe Computer Use.app",12,NSFontWeightMedium)];
  self.path=label(@"",11,NSFontWeightRegular); self.path.textColor=NSColor.secondaryLabelColor;
  self.path.lineBreakMode=NSLineBreakByTruncatingMiddle;
  [self.path setContentCompressionResistancePriority:200 forOrientation:NSLayoutConstraintOrientationHorizontal];
  [identity addArrangedSubview:self.path]; [root addArrangedSubview:identity];
  self.summary=label(@"",12,NSFontWeightRegular); self.summary.lineBreakMode=NSLineBreakByWordWrapping;
  self.summary.maximumNumberOfLines=2; [root addArrangedSubview:self.summary];
  NSView *spacer=[NSView new]; [spacer setContentHuggingPriority:1 forOrientation:NSLayoutConstraintOrientationVertical];
  [root addArrangedSubview:spacer];
  NSStackView *footer=[NSStackView new]; footer.orientation=NSUserInterfaceLayoutOrientationHorizontal;
  footer.distribution=NSStackViewDistributionFill;
  footer.alignment=NSLayoutAttributeCenterY; footer.spacing=10;
  NSTextField *hint=label(@"系统可能要求重新打开应用。授权后，之前的操作不会自动重发。",11,NSFontWeightRegular);
  hint.textColor=NSColor.secondaryLabelColor; hint.maximumNumberOfLines=2; hint.lineBreakMode=NSLineBreakByWordWrapping;
  [hint setContentHuggingPriority:100 forOrientation:NSLayoutConstraintOrientationHorizontal];
  [hint setContentCompressionResistancePriority:200 forOrientation:NSLayoutConstraintOrientationHorizontal]; [footer addArrangedSubview:hint];
  NSStackView *actions=[NSStackView new]; actions.orientation=NSUserInterfaceLayoutOrientationHorizontal;
  actions.distribution=NSStackViewDistributionFill;
  [actions setHuggingPriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationHorizontal];
  actions.alignment=NSLayoutAttributeCenterY; actions.spacing=10; [footer addArrangedSubview:actions];
  self.later=[NSButton buttonWithTitle:@"稍后处理" target:self action:@selector(later:)];
  self.later.bezelStyle=NSBezelStyleRounded; [actions addArrangedSubview:self.later];
  self.recheck=[NSButton buttonWithTitle:@"重新检查" target:self action:@selector(requestCheck:)];
  self.recheck.bezelStyle=NSBezelStyleRounded; [actions addArrangedSubview:self.recheck];
  self.done=[NSButton buttonWithTitle:@"完成" target:self action:@selector(later:)]; self.done.bezelStyle=NSBezelStyleRounded;
  [actions addArrangedSubview:self.done]; [root addArrangedSubview:footer];
  [NSLayoutConstraint activateConstraints:@[
    [header.widthAnchor constraintEqualToAnchor:root.widthAnchor], [rows.widthAnchor constraintEqualToAnchor:root.widthAnchor],
    [identity.widthAnchor constraintEqualToAnchor:root.widthAnchor], [self.path.widthAnchor constraintEqualToAnchor:identity.widthAnchor],
    [self.summary.widthAnchor constraintEqualToAnchor:root.widthAnchor], [footer.widthAnchor constraintEqualToAnchor:root.widthAnchor],
    [actions.trailingAnchor constraintEqualToAnchor:footer.trailingAnchor]
  ]];
  [self applyReport:self.report];
  [self.window center]; [self.window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0), ^{
    char *line=NULL; size_t size=0;
    while (getline(&line,&size,stdin)>0) {
      NSData *bytes=[[NSString stringWithUTF8String:line] dataUsingEncoding:NSUTF8StringEncoding];
      NSDictionary *report=[NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
      if ([report isKindOfClass:NSDictionary.class]) dispatch_async(dispatch_get_main_queue(), ^{ [self applyReport:report]; });
    }
    free(line); dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
  });
}
@end
int main(int argc,const char *argv[]) { @autoreleasepool {
  if (argc!=2) return 64;
  NSData *data=[[NSString stringWithUTF8String:argv[1]] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *report=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![report isKindOfClass:NSDictionary.class]) return 64;
  [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  PermissionPanel *delegate=[PermissionPanel new]; delegate.report=report; NSApp.delegate=delegate; [NSApp run];
} return 0; }
`;
