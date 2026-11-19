#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <ifaddrs.h>
#include <arpa/inet.h>
#include <net/if.h>

@interface AppDelegate : NSObject <NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate>
@property (strong, nonatomic) NSWindow *mainWindow;
@property (strong, nonatomic) WKWebView *webView;
@property (strong, nonatomic) NSMutableArray<NSWindow *> *childWindows;
@property (strong, nonatomic) NSTask *serverTask;
@property (copy, nonatomic) NSString *projectRoot;
@property (assign, nonatomic) NSInteger serverPort;
@end

@implementation AppDelegate

- (instancetype)init {
    self = [super init];
    if (self) {
        _childWindows = [NSMutableArray array];
        _serverPort = 3000;
    }
    return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.projectRoot = [self resolveProjectRoot];
    [self setupMenu];
    [self createMainWindow];
    [self ensureServerAndLoad];
}

- (NSString *)resolveProjectRoot {
    NSFileManager *fm = [NSFileManager defaultManager];
    // 1. Bundle parent folder (when .app is inside the project folder)
    NSString *bundleParent = [[[NSBundle mainBundle] bundlePath] stringByDeletingLastPathComponent];
    if ([fm fileExistsAtPath:[bundleParent stringByAppendingPathComponent:@"server/index.js"]]) {
        return bundleParent;
    }
    // 2. Embedded inside .app bundle (Resources/app)
    NSString *embedded = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"app"];
    if ([fm fileExistsAtPath:[embedded stringByAppendingPathComponent:@"server/index.js"]]) {
        return embedded;
    }
    // 3. Fallback to current working directory
    return [fm currentDirectoryPath];
}

- (NSString *)findNodeBinary {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSArray<NSString *> *candidates = @[
        @"/opt/homebrew/bin/node",
        @"/usr/local/bin/node",
        @"/usr/bin/node",
        [NSHomeDirectory() stringByAppendingPathComponent:@".volta/bin/node"],
        [NSHomeDirectory() stringByAppendingPathComponent:@".local/share/fnm/aliases/default/bin/node"]
    ];
    for (NSString *path in candidates) {
        if ([fm isExecutableFileAtPath:path]) {
            return path;
        }
    }
    // Check ~/.nvm/versions/node/*/bin/node
    NSString *nvmDir = [NSHomeDirectory() stringByAppendingPathComponent:@".nvm/versions/node"];
    if ([fm fileExistsAtPath:nvmDir]) {
        NSArray<NSString *> *subdirs = [fm contentsOfDirectoryAtPath:nvmDir error:nil];
        for (NSString *dir in [subdirs reverseObjectEnumerator]) {
            NSString *nodePath = [nvmDir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@/bin/node", dir]];
            if ([fm isExecutableFileAtPath:nodePath]) {
                return nodePath;
            }
        }
    }
    // Check if PATH has node
    NSTask *whichTask = [[NSTask alloc] init];
    whichTask.executableURL = [NSURL fileURLWithPath:@"/usr/bin/which"];
    whichTask.arguments = @[@"node"];
    NSPipe *pipe = [NSPipe pipe];
    whichTask.standardOutput = pipe;
    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    NSString *oldPath = env[@"PATH"] ?: @"/usr/bin:/bin";
    env[@"PATH"] = [NSString stringWithFormat:@"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:%@", oldPath];
    whichTask.environment = env;
    if ([whichTask launchAndReturnError:nil]) {
        [whichTask waitUntilExit];
        if (whichTask.terminationStatus == 0) {
            NSData *data = [[pipe fileHandleForReading] readDataToEndOfFile];
            NSString *outStr = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
            if (outStr.length > 0 && [fm isExecutableFileAtPath:outStr]) {
                return outStr;
            }
        }
    }
    return nil;
}

- (void)promptToInstallNode {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"Node.js Required";
        alert.informativeText = @"IRBY Dental Ledger requires Node.js (v22 LTS) to run the clinic records and database.\n\nWould you like to download the official macOS installer now?";
        [alert addButtonWithTitle:@"Download Node.js (.pkg)"];
        [alert addButtonWithTitle:@"Visit nodejs.org"];
        [alert addButtonWithTitle:@"Quit"];
        NSModalResponse resp = [alert runModal];
        if (resp == NSAlertFirstButtonReturn) {
            NSURL *pkgUrl = [NSURL URLWithString:@"https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg"];
            [[NSWorkspace sharedWorkspace] openURL:pkgUrl];
        } else if (resp == NSAlertSecondButtonReturn) {
            [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:@"https://nodejs.org/en/download"]];
        }
        [NSApp terminate:nil];
    });
}

- (void)checkServerHealth:(void (^)(BOOL alive))completion {
    NSString *urlStr = [NSString stringWithFormat:@"http://127.0.0.1:%ld/api/health", (long)self.serverPort];
    NSURL *url = [NSURL URLWithString:urlStr];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    req.timeoutInterval = 0.6;
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
        BOOL ok = (error == nil && [http isKindOfClass:[NSHTTPURLResponse class]] && http.statusCode == 200);
        completion(ok);
    }];
    [task resume];
}

- (void)ensureServerAndLoad {
    __weak typeof(self) weakSelf = self;
    [self checkServerHealth:^(BOOL alive) {
        if (alive) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [weakSelf loadAppURL];
            });
        } else {
            [weakSelf startNodeServer];
            [weakSelf pollUntilReady:45];
        }
    }];
}

- (void)startNodeServer {
    NSString *nodeBin = [self findNodeBinary];
    if (!nodeBin) {
        [self promptToInstallNode];
        return;
    }

    NSTask *task = [[NSTask alloc] init];
    task.currentDirectoryURL = [NSURL fileURLWithPath:self.projectRoot];

    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    NSString *oldPath = env[@"PATH"] ?: @"/usr/bin:/bin";
    env[@"PATH"] = [NSString stringWithFormat:@"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:%@", oldPath];
    task.environment = env;

    task.executableURL = [NSURL fileURLWithPath:nodeBin];
    task.arguments = @[@"--disable-warning=ExperimentalWarning", @"server/index.js"];

    NSError *err = nil;
    if ([task launchAndReturnError:&err]) {
        self.serverTask = task;
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSAlert *alert = [[NSAlert alloc] init];
            alert.messageText = @"Could not start IRBY Dental Ledger server";
            alert.informativeText = err.localizedDescription ?: @"Unknown error";
            [alert runModal];
        });
    }
}

- (void)pollUntilReady:(NSInteger)attemptsLeft {
    __weak typeof(self) weakSelf = self;
    [self checkServerHealth:^(BOOL alive) {
        if (alive) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [weakSelf loadAppURL];
            });
        } else if (attemptsLeft > 0) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(200 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
                [weakSelf pollUntilReady:(attemptsLeft - 1)];
            });
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                NSAlert *alert = [[NSAlert alloc] init];
                alert.messageText = @"Server Startup Timed Out";
                alert.informativeText = [NSString stringWithFormat:@"Could not reach http://localhost:%ld. Ensure Node.js 22.13+ is installed and project files exist at:\n%@", (long)weakSelf.serverPort, weakSelf.projectRoot];
                [alert runModal];
            });
        }
    }];
}

- (void)loadAppURL {
    NSString *urlStr = [NSString stringWithFormat:@"http://localhost:%ld", (long)self.serverPort];
    NSURL *url = [NSURL URLWithString:urlStr];
    [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
}

- (void)createMainWindow {
    NSRect rect = NSMakeRect(0, 0, 1360, 860);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
    self.mainWindow = [[NSWindow alloc] initWithContentRect:rect styleMask:style backing:NSBackingStoreBuffered defer:NO];
    self.mainWindow.title = @"IRBY Dental Ledger";
    self.mainWindow.minSize = NSMakeSize(960, 640);
    self.mainWindow.backgroundColor = [NSColor colorWithCalibratedRed:0.953 green:0.937 blue:0.918 alpha:1.0];
    [self.mainWindow center];
    self.mainWindow.delegate = self;

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    config.preferences.javaScriptCanOpenWindowsAutomatically = YES;

    self.webView = [[WKWebView alloc] initWithFrame:rect configuration:config];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.UIDelegate = self;
    self.webView.navigationDelegate = self;

    self.mainWindow.contentView = self.webView;
    [self.mainWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

// Handle window.open (e.g. /print.html)
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)navigationAction windowFeatures:(WKWindowFeatures *)windowFeatures {
    NSRect rect = NSMakeRect(0, 0, 980, 820);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
    NSWindow *popupWindow = [[NSWindow alloc] initWithContentRect:rect styleMask:style backing:NSBackingStoreBuffered defer:NO];
    popupWindow.title = @"IRBY Dental Ledger — Print / PDF";
    [popupWindow center];

    WKWebView *popupWebView = [[WKWebView alloc] initWithFrame:rect configuration:configuration];
    popupWebView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    popupWebView.UIDelegate = self;
    popupWebView.navigationDelegate = self;
    popupWindow.contentView = popupWebView;
    [popupWindow makeKeyAndOrderFront:nil];
    [self.childWindows addObject:popupWindow];
    return popupWebView;
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"IRBY Dental Ledger";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert runModal];
    completionHandler();
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Confirm";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Cancel"];
    NSModalResponse resp = [alert runModal];
    completionHandler(resp == NSAlertFirstButtonReturn);
}

- (void)setupMenu {
    NSMenu *mainMenu = [[NSMenu alloc] init];

    // App Menu
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:appMenuItem];
    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"About IRBY Dental Ledger" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Hide IRBY Dental Ledger" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItemWithTitle:@"Quit IRBY Dental Ledger" action:@selector(terminate:) keyEquivalent:@"q"];
    appMenuItem.submenu = appMenu;

    // Clinic Menu
    NSMenuItem *clinicMenuItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:clinicMenuItem];
    NSMenu *clinicMenu = [[NSMenu alloc] initWithTitle:@"Clinic"];
    [clinicMenu addItemWithTitle:@"Show LAN Address for Tablets…" action:@selector(showLanInfo) keyEquivalent:@"l"];
    [clinicMenu addItemWithTitle:@"Open Data & Backups Folder" action:@selector(openDataFolder) keyEquivalent:@"d"];
    [clinicMenu addItemWithTitle:@"Open in Default Browser" action:@selector(openInBrowser) keyEquivalent:@"b"];
    [clinicMenu addItem:[NSMenuItem separatorItem]];
    [clinicMenu addItemWithTitle:@"Print…" action:@selector(printPage) keyEquivalent:@"p"];
    clinicMenuItem.submenu = clinicMenu;

    // Edit Menu
    NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:editMenuItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    editMenuItem.submenu = editMenu;

    // View Menu
    NSMenuItem *viewMenuItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:viewMenuItem];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"View"];
    [viewMenu addItemWithTitle:@"Reload" action:@selector(reloadPage) keyEquivalent:@"r"];
    viewMenuItem.submenu = viewMenu;

    NSApp.mainMenu = mainMenu;
}

- (void)reloadPage {
    [self.webView reload];
}

- (void)openDataFolder {
    NSString *dataPath = [self.projectRoot stringByAppendingPathComponent:@"data"];
    [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:dataPath]];
}

- (void)openInBrowser {
    NSString *urlStr = [NSString stringWithFormat:@"http://localhost:%ld", (long)self.serverPort];
    [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:urlStr]];
}

- (void)printPage {
    NSWindow *activeWin = [NSApp keyWindow] ?: self.mainWindow;
    WKWebView *targetWebView = ([activeWin.contentView isKindOfClass:[WKWebView class]]) ? (WKWebView *)activeWin.contentView : self.webView;
    NSPrintInfo *printInfo = [NSPrintInfo sharedPrintInfo];
    NSPrintOperation *op = [targetWebView printOperationWithPrintInfo:printInfo];
    op.showsPrintPanel = YES;
    op.showsProgressPanel = YES;
    [op runOperationModalForWindow:activeWin delegate:nil didRunSelector:NULL contextInfo:NULL];
}

- (void)showLanInfo {
    NSMutableArray<NSString *> *addresses = [NSMutableArray array];
    struct ifaddrs *interfaces = NULL;
    if (getifaddrs(&interfaces) == 0) {
        struct ifaddrs *temp = interfaces;
        while (temp != NULL) {
            if (temp->ifa_addr && temp->ifa_addr->sa_family == AF_INET && !(temp->ifa_flags & IFF_LOOPBACK)) {
                char addrBuf[INET_ADDRSTRLEN];
                struct sockaddr_in *sin = (struct sockaddr_in *)temp->ifa_addr;
                if (inet_ntop(AF_INET, &sin->sin_addr, addrBuf, sizeof(addrBuf))) {
                    [addresses addObject:[NSString stringWithFormat:@"http://%s:%ld", addrBuf, (long)self.serverPort]];
                }
            }
            temp = temp->ifa_next;
        }
        freeifaddrs(interfaces);
    }
    NSString *list = addresses.count > 0 ? [addresses componentsJoinedByString:@"\n"] : @"No LAN IPv4 address detected.";
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Connect Chairside Tablets (LAN)";
    alert.informativeText = [NSString stringWithFormat:@"Open any of these URLs on tablets on the same Wi-Fi network:\n\n%@\n\nLocal Mac: http://localhost:%ld", list, (long)self.serverPort];
    [alert runModal];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.serverTask && self.serverTask.isRunning) {
        [self.serverTask terminate];
    }
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
