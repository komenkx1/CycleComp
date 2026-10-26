#import "TerrainRoadMatcherBridge.h"

#include "cyclecomp/road_matcher.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <memory>

using cyclecomp::terrain::DirectedEdgeCandidate;
using cyclecomp::terrain::ForwardPathQuality;
using cyclecomp::terrain::MotionState;
using cyclecomp::terrain::Observation;
using cyclecomp::terrain::ProfileQuality;
using cyclecomp::terrain::RoadMatcher;

namespace {

std::optional<std::int64_t> integerValue(NSDictionary<NSString *, id> *record, NSString *key) {
  id value = record[key];
  if (![value isKindOfClass:NSNumber.class]) return std::nullopt;
  return static_cast<std::int64_t>([value longLongValue]);
}

std::optional<double> numberValue(NSDictionary<NSString *, id> *record, NSString *key) {
  id value = record[key];
  if (![value isKindOfClass:NSNumber.class]) return std::nullopt;
  const double number = [value doubleValue];
  return std::isfinite(number) ? std::optional<double>(number) : std::nullopt;
}

double doubleFromLittleEndian(const unsigned char *bytes) {
  std::uint64_t bits = 0;
  for (unsigned int byteIndex = 0; byteIndex < 8; byteIndex += 1) {
    bits |= static_cast<std::uint64_t>(bytes[byteIndex]) << (byteIndex * 8);
  }
  return std::bit_cast<double>(bits);
}

std::optional<DirectedEdgeCandidate> candidateFromRecord(NSDictionary<NSString *, id> *record) {
  const auto edgeID = integerValue(record, @"edgeID");
  const auto segmentID = integerValue(record, @"segmentID");
  const auto fromNodeID = integerValue(record, @"fromNodeID");
  const auto toNodeID = integerValue(record, @"toNodeID");
  const auto lengthMeters = numberValue(record, @"lengthMeters");
  const auto direction = integerValue(record, @"direction");
  id geometryValue = record[@"geometryData"];
  if (!edgeID || !segmentID || !fromNodeID || !toNodeID || !lengthMeters || !direction ||
      ![geometryValue isKindOfClass:NSData.class]) return std::nullopt;

  NSData *geometryData = geometryValue;
  if (geometryData.length < 32 || geometryData.length > 131'072 ||
      geometryData.length % 16 != 0) return std::nullopt;

  DirectedEdgeCandidate candidate;
  candidate.edge_id = *edgeID;
  candidate.segment_id = *segmentID;
  candidate.from_node_id = *fromNodeID;
  candidate.to_node_id = *toNodeID;
  candidate.length_meters = *lengthMeters;
  const auto *geometryBytes = static_cast<const unsigned char *>(geometryData.bytes);
  const NSUInteger coordinateCount = geometryData.length / 16;
  candidate.directed_geometry.reserve(coordinateCount);
  for (NSUInteger index = 0; index < coordinateCount; index += 1) {
    const double longitude = doubleFromLittleEndian(geometryBytes + index * 16);
    const double latitude = doubleFromLittleEndian(geometryBytes + index * 16 + 8);
    if (!std::isfinite(longitude) || !std::isfinite(latitude)) return std::nullopt;
    candidate.directed_geometry.push_back({longitude, latitude});
  }
  if (*direction < 0) std::reverse(candidate.directed_geometry.begin(), candidate.directed_geometry.end());

  candidate.corridor_id = integerValue(record, @"corridorID");
  candidate.corridor_start_distance_meters =
      numberValue(record, @"corridorStartDistanceMeters").value_or(0);
  candidate.corridor_length_meters =
      numberValue(record, @"corridorLengthMeters").value_or(0);
  NSString *profileQuality = [record[@"profileQuality"] isKindOfClass:NSString.class]
      ? record[@"profileQuality"] : @"";
  if ([profileQuality isEqualToString:@"complete"]) candidate.profile_quality = ProfileQuality::complete;
  else if ([profileQuality isEqualToString:@"partial"]) candidate.profile_quality = ProfileQuality::partial;

  NSString *forwardPathQuality = [record[@"forwardPathQuality"] isKindOfClass:NSString.class]
      ? record[@"forwardPathQuality"] : @"";
  if ([forwardPathQuality isEqualToString:@"known_to_boundary"])
    candidate.forward_path_quality = ForwardPathQuality::known_to_boundary;
  else if ([forwardPathQuality isEqualToString:@"inferred_to_boundary"])
    candidate.forward_path_quality = ForwardPathQuality::inferred_to_boundary;
  else if ([forwardPathQuality isEqualToString:@"ambiguous"])
    candidate.forward_path_quality = ForwardPathQuality::ambiguous;
  candidate.predictable = [record[@"predictable"] boolValue];
  return candidate;
}

id nullableInteger(std::optional<std::int64_t> value) {
  return value ? @(*value) : NSNull.null;
}

id nullableDouble(std::optional<double> value) {
  return value ? @(*value) : NSNull.null;
}

}

@interface TerrainRoadMatcherBridge () {
  std::unique_ptr<RoadMatcher> _matcher;
}
@end

@implementation TerrainRoadMatcherBridge

- (instancetype)init {
  self = [super init];
  if (self) _matcher = std::make_unique<RoadMatcher>();
  return self;
}

- (NSDictionary<NSString *, id> *)updateLongitude:(double)longitude
                                          latitude:(double)latitude
                       horizontalAccuracyMeters:(double)horizontalAccuracyMeters
                       monotonicTimeMilliseconds:(int64_t)monotonicTimeMilliseconds
                            speedMetersPerSecond:(NSNumber *)speedMetersPerSecond
                                   courseDegrees:(NSNumber *)courseDegrees
                                      motionState:(NSString *)motionState
                                 candidateRecords:(NSArray<NSDictionary<NSString *, id> *> *)candidateRecords {
  Observation observation;
  observation.monotonic_time_milliseconds = monotonicTimeMilliseconds;
  observation.coordinate = {longitude, latitude};
  observation.horizontal_accuracy_meters = horizontalAccuracyMeters;
  if (speedMetersPerSecond) observation.speed_meters_per_second = speedMetersPerSecond.doubleValue;
  if (courseDegrees) observation.course_degrees = courseDegrees.doubleValue;
  if ([motionState isEqualToString:@"moving"]) observation.motion_state = MotionState::moving;
  else if ([motionState isEqualToString:@"stationary"]) observation.motion_state = MotionState::stationary;

  std::vector<DirectedEdgeCandidate> candidates;
  if (candidateRecords.count > 48) {
    candidates.resize(49);
  } else {
    candidates.reserve(candidateRecords.count);
    for (NSDictionary<NSString *, id> *record in candidateRecords) {
      const auto candidate = candidateFromRecord(record);
      if (candidate) candidates.push_back(*candidate);
    }
  }

  const auto match = _matcher->update(observation, candidates);
  return @{
    @"status": [NSString stringWithUTF8String:cyclecomp::terrain::toString(match.status)],
    @"positionMatchQuality": [NSString stringWithUTF8String:cyclecomp::terrain::toString(match.position_quality)],
    @"forwardPathQuality": [NSString stringWithUTF8String:cyclecomp::terrain::toString(match.forward_path_quality)],
    @"profileQuality": [NSString stringWithUTF8String:cyclecomp::terrain::toString(match.profile_quality)],
    @"matchedEdgeID": nullableInteger(match.matched_edge_id),
    @"matchedSegmentID": nullableInteger(match.matched_segment_id),
    @"corridorID": nullableInteger(match.corridor_id),
    @"positionAlongEdgeMeters": nullableDouble(match.position_along_edge_meters),
    @"positionAlongCorridorMeters": nullableDouble(match.position_along_corridor_meters),
    @"lateralDistanceMeters": nullableDouble(match.lateral_distance_meters),
    @"profileDistanceToBoundaryMeters": nullableDouble(match.profile_distance_to_boundary_meters),
    @"candidateScoreMargin": @(match.candidate_score_margin),
    @"reason": [NSString stringWithUTF8String:match.reason],
  };
}

- (void)reset {
  _matcher->reset();
}

@end
