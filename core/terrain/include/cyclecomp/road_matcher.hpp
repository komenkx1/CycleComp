#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace cyclecomp::terrain {

struct Coordinate {
  double longitude_degrees = 0;
  double latitude_degrees = 0;
};

enum class MotionState {
  unknown,
  moving,
  stationary,
};

enum class MatchStatus {
  acquiring,
  matched,
  uncertain,
  out_of_coverage,
  invalid_observation,
};

enum class PositionMatchQuality {
  unavailable,
  low,
  medium,
  high,
};

enum class ForwardPathQuality {
  unavailable,
  ambiguous,
  known_to_boundary,
  inferred_to_boundary,
};

enum class ProfileQuality {
  unavailable,
  partial,
  complete,
};

struct Observation {
  std::int64_t monotonic_time_milliseconds = 0;
  Coordinate coordinate;
  double horizontal_accuracy_meters = 0;
  std::optional<double> speed_meters_per_second;
  std::optional<double> course_degrees;
  MotionState motion_state = MotionState::unknown;
};

struct DirectedEdgeCandidate {
  std::int64_t edge_id = 0;
  std::int64_t segment_id = 0;
  std::int64_t from_node_id = 0;
  std::int64_t to_node_id = 0;
  double length_meters = 0;
  std::vector<Coordinate> directed_geometry;
  std::optional<std::int64_t> corridor_id;
  double corridor_start_distance_meters = 0;
  double corridor_length_meters = 0;
  ProfileQuality profile_quality = ProfileQuality::unavailable;
  ForwardPathQuality forward_path_quality = ForwardPathQuality::unavailable;
  bool predictable = false;
};

struct MatchResult {
  MatchStatus status = MatchStatus::acquiring;
  PositionMatchQuality position_quality = PositionMatchQuality::unavailable;
  ForwardPathQuality forward_path_quality = ForwardPathQuality::unavailable;
  ProfileQuality profile_quality = ProfileQuality::unavailable;
  std::optional<std::int64_t> matched_edge_id;
  std::optional<std::int64_t> matched_segment_id;
  std::optional<std::int64_t> corridor_id;
  std::optional<double> position_along_edge_meters;
  std::optional<double> position_along_corridor_meters;
  std::optional<double> lateral_distance_meters;
  std::optional<double> profile_distance_to_boundary_meters;
  double candidate_score_margin = 0;
  const char* reason = "acquiring";
};

struct RoadMatcherConfig {
  std::size_t maximum_candidate_count = 48;
  std::size_t maximum_beam_width = 8;
  double minimum_accuracy_meters = 5;
  double maximum_accuracy_meters = 100;
  double maximum_candidate_radius_meters = 75;
  std::int64_t maximum_observation_gap_milliseconds = 12'000;
  double maximum_speed_meters_per_second = 40;
};

class RoadMatcher {
 public:
  explicit RoadMatcher(RoadMatcherConfig config = {});

  MatchResult update(
      const Observation& observation,
      const std::vector<DirectedEdgeCandidate>& candidates);
  void reset();

  double candidateRadiusMeters(double horizontal_accuracy_meters) const;

 private:
  struct Hypothesis {
    DirectedEdgeCandidate candidate;
    double position_along_edge_meters = 0;
    double lateral_distance_meters = 0;
    double course_degrees = 0;
    double score = 0;
  };

  RoadMatcherConfig config_;
  std::vector<Hypothesis> hypotheses_;
  std::optional<Observation> previous_observation_;
};

const char* toString(MatchStatus value);
const char* toString(PositionMatchQuality value);
const char* toString(ForwardPathQuality value);
const char* toString(ProfileQuality value);

}
