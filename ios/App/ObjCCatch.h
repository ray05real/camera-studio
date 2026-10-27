#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs the block and returns the reason if it threw an Objective-C exception, else nil.
/// AVFoundation reports some mistakes by throwing, which Swift can't catch and which would close the app.
NSString *_Nullable CSTry(NS_NOESCAPE void (^block)(void));

/// Remembers why the app closed if an Objective-C exception wasn't caught, for the PC to show next time.
void CSInstallCrashRecorder(void);

/// The reason saved last time (and forgets it), or nil.
NSString *_Nullable CSTakeLastCrash(void);

NS_ASSUME_NONNULL_END
