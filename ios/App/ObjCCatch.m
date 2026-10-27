#import "ObjCCatch.h"

NSString *_Nullable CSTry(NS_NOESCAPE void (^block)(void)) {
    @try {
        block();
        return nil;
    } @catch (NSException *e) {
        return [NSString stringWithFormat:@"%@: %@", e.name, e.reason ?: @""];
    }
}

static void CSRecordException(NSException *e) {
    NSArray<NSString *> *stack = e.callStackSymbols ?: @[];
    NSArray<NSString *> *top = [stack subarrayWithRange:NSMakeRange(0, MIN((NSUInteger)12, stack.count))];
    NSString *text = [NSString stringWithFormat:@"%@: %@\n%@", e.name, e.reason ?: @"", [top componentsJoinedByString:@"\n"]];
    [[NSUserDefaults standardUserDefaults] setObject:text forKey:@"lastCrash"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

void CSInstallCrashRecorder(void) {
    NSSetUncaughtExceptionHandler(&CSRecordException);
}

NSString *_Nullable CSTakeLastCrash(void) {
    NSString *text = [[NSUserDefaults standardUserDefaults] stringForKey:@"lastCrash"];
    if (text) [[NSUserDefaults standardUserDefaults] removeObjectForKey:@"lastCrash"];
    return text;
}
