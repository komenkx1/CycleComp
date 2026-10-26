#include "cyclecomp/road_matcher.hpp"

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

using cyclecomp::terrain::Coordinate;
using cyclecomp::terrain::DirectedEdgeCandidate;
using cyclecomp::terrain::ForwardPathQuality;
using cyclecomp::terrain::MatchStatus;
using cyclecomp::terrain::MotionState;
using cyclecomp::terrain::Observation;
using cyclecomp::terrain::PositionMatchQuality;
using cyclecomp::terrain::ProfileQuality;
using cyclecomp::terrain::RoadMatcher;

namespace {

void require(bool condition, const std::string& message) {
  if (condition) return;
  std::cerr << message << '\n';
  std::exit(EXIT_FAILURE);
}

DirectedEdgeCandidate eastboundEdge(
    std::int64_t edge_id,
    std::int64_t segment_id,
    std::int64_t from_node_id,
    std::int64_t to_node_id,
    double latitude_degrees = 0) {
  return DirectedEdgeCandidate{
      edge_id,
      segment_id,
      from_node_id,
      to_node_id,
      222.4,
      {{-0.001, latitude_degrees}, {0.001, latitude_degrees}},
      std::nullopt,
      0,
      500,
      ProfileQuality::complete,
      ForwardPathQuality::known_to_boundary,
      true,
  };
}

Observation observation(
    std::int64_t time_milliseconds,
    double longitude_degrees,
    double latitude_degrees,
    double accuracy_meters,
    MotionState motion_state = MotionState::moving) {
  return Observation{
      time_milliseconds,
      {longitude_degrees, latitude_degrees},
      accuracy_meters,
      2.8,
      90.0,
      motion_state,
  };
}

void testCandidateRadiusFollowsAccuracyAndHasCap() {
  RoadMatcher matcher;
  require(matcher.candidateRadiusMeters(3) == 20,
          "high accuracy should retain a useful minimum query radius");
  require(matcher.candidateRadiusMeters(12) == 34,
          "query radius should grow with horizontal accuracy");
  require(matcher.candidateRadiusMeters(80) == 75,
          "query radius must not exceed its configured cap");
}

void testAcquiresThenKeepsConnectedDirection() {
  RoadMatcher matcher;
  const DirectedEdgeCandidate firstEdge = eastboundEdge(11, 7, 1, 2);
  const DirectedEdgeCandidate nextEdge{
      12,
      8,
      2,
      3,
      111.2,
      {{0.001, 0}, {0.002, 0}},
      41,
      220,
      400,
      ProfileQuality::complete,
      ForwardPathQuality::known_to_boundary,
      true,
  };

  const auto firstResult = matcher.update(
      observation(1'000, 0.0005, 0, 4), {firstEdge});
  require(firstResult.status == MatchStatus::acquiring,
          "the first fix must acquire without claiming stable continuity");
  require(firstResult.position_quality == PositionMatchQuality::high,
          "a close road projection should retain its position quality while acquiring");

  const auto secondResult = matcher.update(
      observation(5'000, 0.0012, 0, 5), {firstEdge, nextEdge});
  require(secondResult.status == MatchStatus::matched,
          "a connected next edge should stabilize the match");
  require(secondResult.matched_edge_id == 12,
          "the matcher should advance onto the connected directed edge");
  require(secondResult.corridor_id == 41,
          "the match should preserve its road corridor identity");
  require(secondResult.profile_quality == ProfileQuality::complete,
          "profile coverage should remain distinct from position quality");
  require(secondResult.position_along_corridor_meters.has_value(),
          "stable matches should expose their corridor position");
  require(std::abs(*secondResult.position_along_corridor_meters - 242.2) < 1,
          "corridor position should include the edge offset and projected position");
  require(secondResult.profile_distance_to_boundary_meters.has_value() &&
              std::abs(*secondResult.profile_distance_to_boundary_meters - 157.8) < 1,
          "known profile distance should end at the verified corridor boundary");
}

void testContinuityRejectsNearbyParallelRoadJump() {
  RoadMatcher matcher;
  const DirectedEdgeCandidate riddenRoad = eastboundEdge(21, 21, 1, 2);
  const DirectedEdgeCandidate parallelRoad = eastboundEdge(22, 22, 3, 4, 0.0002);

  matcher.update(observation(1'000, 0.0001, 0, 3), {riddenRoad});
  const auto result = matcher.update(
      observation(5'000, 0.0002, 0.00017, 20), {riddenRoad, parallelRoad});

  require(result.matched_edge_id == 21,
          "one noisy fix must not switch to a closer but disconnected parallel road");
  require(result.status == MatchStatus::matched,
          "continuity on the ridden road should remain stable");
}

void testAmbiguousRoadsKeepForwardQualitySeparate() {
  RoadMatcher matcher;
  const DirectedEdgeCandidate firstRoad = eastboundEdge(31, 31, 1, 2);
  const DirectedEdgeCandidate indistinguishableRoad = eastboundEdge(32, 32, 3, 4);

  matcher.update(observation(1'000, 0, 0, 5), {firstRoad, indistinguishableRoad});
  const auto result = matcher.update(
      observation(3'000, 0.00005, 0, 5), {firstRoad, indistinguishableRoad});

  require(result.position_quality == PositionMatchQuality::high,
          "position can be accurate while route choice is ambiguous");
  require(result.status == MatchStatus::uncertain,
          "equal candidate paths must not produce a confident match");
  require(result.forward_path_quality == ForwardPathQuality::ambiguous,
          "forward path quality should expose the competing paths");
  require(result.profile_quality == ProfileQuality::unavailable,
          "an ambiguous route must not expose one candidate's profile");
}

void testStationaryObservationDoesNotUseHeading() {
  RoadMatcher matcher;
  const DirectedEdgeCandidate eastboundRoad = eastboundEdge(41, 41, 1, 2);
  Observation stopped = observation(1'000, 0, 0, 4, MotionState::stationary);
  stopped.speed_meters_per_second = 0;
  stopped.course_degrees = 270;

  const auto result = matcher.update(stopped, {eastboundRoad});
  require(result.status == MatchStatus::acquiring,
          "stationary heading should not create a false direction match");
  require(result.position_quality == PositionMatchQuality::high,
          "stationary positioning can still be reported independently");
}

void testObservationGapForcesReacquisition() {
  RoadMatcher matcher;
  const DirectedEdgeCandidate road = eastboundEdge(51, 51, 1, 2);
  matcher.update(observation(1'000, 0, 0, 4), {road});
  const auto result = matcher.update(observation(20'000, 0.0002, 0, 4), {road});

  require(result.status == MatchStatus::acquiring,
          "a long observation gap must not preserve stale confidence");
  require(std::string(result.reason) == "observation_gap",
          "a long gap should be visible in the match reason");
}

void testOutOfCoverageAndInvalidObservationDoNotReturnRoads() {
  RoadMatcher matcher;
  const auto invalid = matcher.update(observation(1'000, 181, 0, 4), {});
  require(invalid.status == MatchStatus::invalid_observation,
          "invalid coordinates must be rejected before matching");

  const auto outside = matcher.update(observation(2'000, 0, 0, 4), {});
  require(outside.status == MatchStatus::out_of_coverage,
          "an empty local graph must be reported as out of coverage");
  require(!outside.matched_edge_id,
          "out of coverage must not retain an earlier edge as a current match");
}

void testReverseDirectedEdgeNeedsTurnaroundEvidence() {
  RoadMatcher matcher;
  const DirectedEdgeCandidate eastboundRoad = eastboundEdge(61, 61, 1, 2);
  const DirectedEdgeCandidate westboundRoad{
      62,
      61,
      2,
      1,
      222.4,
      {{0.001, 0}, {-0.001, 0}},
      std::nullopt,
      0,
      0,
      ProfileQuality::complete,
      ForwardPathQuality::known_to_boundary,
      true,
  };

  matcher.update(observation(1'000, -0.0002, 0, 4), {eastboundRoad, westboundRoad});
  const auto result = matcher.update(
      observation(4'000, 0.0001, 0, 4), {eastboundRoad, westboundRoad});
  require(result.matched_edge_id == 61,
          "the matcher must not reverse direction from an eastbound course and noisy fix");
}

void testInferredAccessDoesNotBecomeVerifiedAccess() {
  RoadMatcher matcher;
  DirectedEdgeCandidate road = eastboundEdge(71, 71, 1, 2);
  road.corridor_id = 0;
  road.forward_path_quality = ForwardPathQuality::inferred_to_boundary;
  matcher.update(observation(1'000, 0, 0, 4), {road});
  const auto match = matcher.update(observation(2'000, 0.00003, 0, 4), {road});

  require(match.status == MatchStatus::matched,
          "an inferred-access road can still have a stable position match");
  require(match.forward_path_quality == ForwardPathQuality::inferred_to_boundary,
          "stable positioning must preserve inferred access provenance");
  require(match.profile_quality == ProfileQuality::complete &&
              match.position_along_corridor_meters.has_value(),
          "inferred access must remain separate from profile coverage");
}

}

int main() {
  testCandidateRadiusFollowsAccuracyAndHasCap();
  testAcquiresThenKeepsConnectedDirection();
  testContinuityRejectsNearbyParallelRoadJump();
  testAmbiguousRoadsKeepForwardQualitySeparate();
  testStationaryObservationDoesNotUseHeading();
  testObservationGapForcesReacquisition();
  testOutOfCoverageAndInvalidObservationDoNotReturnRoads();
  testReverseDirectedEdgeNeedsTurnaroundEvidence();
  testInferredAccessDoesNotBecomeVerifiedAccess();
  std::cout << "RoadMatcher checks passed\n";
  return EXIT_SUCCESS;
}
