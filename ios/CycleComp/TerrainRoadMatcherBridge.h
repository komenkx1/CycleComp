#import <Foundation/Foundation.h>
#include <stdint.h>

NS_ASSUME_NONNULL_BEGIN

@interface TerrainRoadMatcherBridge : NSObject

- (NSDictionary<NSString *, id> *)updateLongitude:(double)longitude
                                          latitude:(double)latitude
                    horizontalAccuracyMeters:(double)horizontalAccuracyMeters
                     monotonicTimeMilliseconds:(int64_t)monotonicTimeMilliseconds
                            speedMetersPerSecond:(nullable NSNumber *)speedMetersPerSecond
                                     courseDegrees:(nullable NSNumber *)courseDegrees
                                        motionState:(NSString *)motionState
                                   candidateRecords:(NSArray<NSDictionary<NSString *, id> *> *)candidateRecords;

- (void)reset;

@end

NS_ASSUME_NONNULL_END
