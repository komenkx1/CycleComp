#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(SFSymbolViewManager, RCTViewManager)
RCT_EXPORT_VIEW_PROPERTY(symbolName, NSString)
RCT_EXPORT_VIEW_PROPERTY(symbolTintColor, UIColor)
@end
