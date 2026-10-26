#include "cyclecomp/road_matcher.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace cyclecomp::terrain {
namespace {

constexpr double kEarthRadiusMeters = 6'371'000.0;
constexpr double kPi = 3.14159265358979323846;
constexpr double kCoursePenaltyLimit = 12.0;
constexpr double kTransitionPenaltyLimit = 14.0;
constexpr double kStableScoreMargin = 1.5;

struct ProjectedCandidate {
  double position_along_edge_meters = 0;
  double lateral_distance_meters = 0;
  double course_degrees = 0;
};

struct LocalCoordinate {
  double east_meters = 0;
  double north_meters = 0;
};

double radians(double degrees) {
  return degrees * kPi / 180.0;
}

double normalizedLongitudeDifference(double difference_degrees) {
  return std::remainder(difference_degrees, 360.0);
}

double distanceMeters(const Coordinate& first, const Coordinate& second) {
  const double first_latitude = radians(first.latitude_degrees);
  const double second_latitude = radians(second.latitude_degrees);
  const double latitude_difference = second_latitude - first_latitude;
  const double longitude_difference = radians(normalizedLongitudeDifference(
      second.longitude_degrees - first.longitude_degrees));
  const double haversine = std::pow(std::sin(latitude_difference / 2), 2) +
      std::cos(first_latitude) * std::cos(second_latitude) *
          std::pow(std::sin(longitude_difference / 2), 2);
  return 2 * kEarthRadiusMeters * std::asin(std::min(1.0, std::sqrt(haversine)));
}

LocalCoordinate projectToLocalMeters(const Coordinate& point, const Coordinate& origin) {
  const double origin_latitude = radians(origin.latitude_degrees);
  return {
      radians(normalizedLongitudeDifference(point.longitude_degrees - origin.longitude_degrees)) *
          kEarthRadiusMeters * std::cos(origin_latitude),
      radians(point.latitude_degrees - origin.latitude_degrees) * kEarthRadiusMeters,
  };
}

double bearingDegrees(const LocalCoordinate& start, const LocalCoordinate& end) {
  const double bearing = std::atan2(end.east_meters - start.east_meters,
                                    end.north_meters - start.north_meters) * 180.0 / kPi;
  return std::fmod(bearing + 360.0, 360.0);
}

double angularDifferenceDegrees(double first, double second) {
  return std::abs(std::remainder(first - second, 360.0));
}

bool validCoordinate(const Coordinate& coordinate) {
  return std::isfinite(coordinate.longitude_degrees) &&
      std::isfinite(coordinate.latitude_degrees) &&
      coordinate.longitude_degrees >= -180 && coordinate.longitude_degrees <= 180 &&
      coordinate.latitude_degrees >= -90 && coordinate.latitude_degrees <= 90;
}

std::optional<ProjectedCandidate> projectCandidate(
    const Observation& observation,
    const DirectedEdgeCandidate& candidate) {
  if (candidate.directed_geometry.size() < 2 ||
      candidate.directed_geometry.size() > 8'192 ||
      !std::isfinite(candidate.length_meters) || candidate.length_meters <= 0) {
    return std::nullopt;
  }

  std::vector<LocalCoordinate> local_geometry;
  local_geometry.reserve(candidate.directed_geometry.size());
  for (const Coordinate& coordinate : candidate.directed_geometry) {
    if (!validCoordinate(coordinate)) return std::nullopt;
    local_geometry.push_back(projectToLocalMeters(coordinate, observation.coordinate));
  }

  double geometry_length_meters = 0;
  double distance_before_segment_meters = 0;
  double closest_geometry_distance_meters = std::numeric_limits<double>::infinity();
  double closest_geometry_position_meters = 0;
  double closest_course_degrees = 0;

  for (std::size_t index = 1; index < candidate.directed_geometry.size(); ++index) {
    const LocalCoordinate& start = local_geometry[index - 1];
    const LocalCoordinate& end = local_geometry[index];
    const double segment_length_meters = distanceMeters(
        candidate.directed_geometry[index - 1], candidate.directed_geometry[index]);
    if (!std::isfinite(segment_length_meters) || segment_length_meters <= 0.01) continue;

    const double east_difference = end.east_meters - start.east_meters;
    const double north_difference = end.north_meters - start.north_meters;
    const double squared_length = east_difference * east_difference +
        north_difference * north_difference;
    if (squared_length <= 1e-6) continue;

    const double projection_fraction = std::clamp(
        -(start.east_meters * east_difference + start.north_meters * north_difference) /
            squared_length,
        0.0,
        1.0);
    const double projected_east = start.east_meters + projection_fraction * east_difference;
    const double projected_north = start.north_meters + projection_fraction * north_difference;
    const double lateral_distance_meters = std::hypot(projected_east, projected_north);
    if (lateral_distance_meters < closest_geometry_distance_meters) {
      closest_geometry_distance_meters = lateral_distance_meters;
      closest_geometry_position_meters = distance_before_segment_meters +
          projection_fraction * segment_length_meters;
      closest_course_degrees = bearingDegrees(start, end);
    }
    geometry_length_meters += segment_length_meters;
    distance_before_segment_meters += segment_length_meters;
  }

  if (!std::isfinite(closest_geometry_distance_meters) || geometry_length_meters <= 0) {
    return std::nullopt;
  }

  return ProjectedCandidate{
      std::clamp(closest_geometry_position_meters / geometry_length_meters, 0.0, 1.0) *
          candidate.length_meters,
      closest_geometry_distance_meters,
      closest_course_degrees,
  };
}

double emissionScore(
    const Observation& observation,
    const ProjectedCandidate& projection,
    double accuracy_floor_meters) {
  const double lateral_scale = std::max(accuracy_floor_meters,
                                        observation.horizontal_accuracy_meters);
  const double normalized_lateral_distance = projection.lateral_distance_meters / lateral_scale;
  double score = std::min(30.0, 0.75 * normalized_lateral_distance * normalized_lateral_distance);

  if (observation.motion_state != MotionState::stationary &&
      observation.course_degrees && observation.speed_meters_per_second &&
      *observation.speed_meters_per_second >= 1.0 &&
      std::isfinite(*observation.course_degrees) &&
      *observation.course_degrees >= 0 && *observation.course_degrees <= 360) {
    const double course_difference = angularDifferenceDegrees(
        projection.course_degrees, *observation.course_degrees);
    const double normalized_course_difference = course_difference / 45.0;
    score += std::min(kCoursePenaltyLimit,
                      1.5 * normalized_course_difference * normalized_course_difference);
  }
  return score;
}

double expectedTravelDistanceMeters(
    const Observation& previous,
    const Observation& current,
    double elapsed_seconds) {
  if (current.motion_state == MotionState::stationary) return 0;
  if (current.speed_meters_per_second &&
      std::isfinite(*current.speed_meters_per_second) &&
      *current.speed_meters_per_second >= 0 &&
      *current.speed_meters_per_second <= 40) {
    return *current.speed_meters_per_second * elapsed_seconds;
  }
  return distanceMeters(previous.coordinate, current.coordinate);
}

bool isPlausibleTransition(
    const RoadMatcherConfig& config,
    const Observation& previous_observation,
    const Observation& current_observation,
    const DirectedEdgeCandidate& previous_candidate,
    double previous_position_along_edge_meters,
    double previous_course_degrees,
    const DirectedEdgeCandidate& current_candidate,
    double current_position_along_edge_meters,
    double& transition_penalty) {
  const double elapsed_seconds = static_cast<double>(
      current_observation.monotonic_time_milliseconds -
      previous_observation.monotonic_time_milliseconds) / 1'000.0;
  if (elapsed_seconds <= 0) return false;

  const double expected_distance_meters = expectedTravelDistanceMeters(
      previous_observation, current_observation, elapsed_seconds);
  const double maximum_plausible_distance_meters =
      config.maximum_speed_meters_per_second * elapsed_seconds +
      previous_observation.horizontal_accuracy_meters +
      current_observation.horizontal_accuracy_meters + 20;

  double route_distance_meters = 0;
  if (previous_candidate.edge_id == current_candidate.edge_id) {
    route_distance_meters = current_position_along_edge_meters -
        previous_position_along_edge_meters;
    const double reverse_tolerance_meters = std::max(
        8.0,
        previous_observation.horizontal_accuracy_meters +
            current_observation.horizontal_accuracy_meters);
    if (route_distance_meters < -reverse_tolerance_meters) return false;
    route_distance_meters = std::max(0.0, route_distance_meters);
  } else if (previous_candidate.to_node_id == current_candidate.from_node_id) {
    route_distance_meters = previous_candidate.length_meters -
        previous_position_along_edge_meters + current_position_along_edge_meters;
  } else if (previous_candidate.segment_id == current_candidate.segment_id &&
             previous_candidate.from_node_id == current_candidate.to_node_id &&
             previous_candidate.to_node_id == current_candidate.from_node_id) {
    const bool course_confirms_turnaround =
        current_observation.motion_state != MotionState::stationary &&
        current_observation.course_degrees &&
        angularDifferenceDegrees(previous_course_degrees,
                                 *current_observation.course_degrees) >= 120;
    const double observed_displacement_meters = distanceMeters(
        previous_observation.coordinate, current_observation.coordinate);
    if (!course_confirms_turnaround &&
        observed_displacement_meters < previous_observation.horizontal_accuracy_meters +
            current_observation.horizontal_accuracy_meters + 5) {
      return false;
    }
    route_distance_meters = previous_position_along_edge_meters +
        current_candidate.length_meters - current_position_along_edge_meters;
  } else {
    return false;
  }

  if (route_distance_meters > maximum_plausible_distance_meters) return false;
  const double transition_scale = std::max(
      10.0,
      previous_observation.horizontal_accuracy_meters +
          current_observation.horizontal_accuracy_meters + expected_distance_meters * 0.5);
  const double normalized_distance_error =
      (route_distance_meters - expected_distance_meters) / transition_scale;
  transition_penalty = std::min(
      kTransitionPenaltyLimit,
      0.6 * normalized_distance_error * normalized_distance_error);

  if (previous_candidate.edge_id != current_candidate.edge_id &&
      previous_candidate.segment_id == current_candidate.segment_id) {
    transition_penalty += 5.0;
  }
  return true;
}

PositionMatchQuality positionQuality(
    double lateral_distance_meters,
    double horizontal_accuracy_meters) {
  const double reliable_distance_meters = std::max(5.0, horizontal_accuracy_meters * 0.5);
  if (lateral_distance_meters <= reliable_distance_meters) return PositionMatchQuality::high;
  if (lateral_distance_meters <= horizontal_accuracy_meters * 1.25) {
    return PositionMatchQuality::medium;
  }
  return PositionMatchQuality::low;
}

MatchResult resultWithoutMatch(MatchStatus status, const char* reason) {
  MatchResult result;
  result.status = status;
  result.reason = reason;
  return result;
}

}

RoadMatcher::RoadMatcher(RoadMatcherConfig config) : config_(config) {
  config_.maximum_candidate_count = std::clamp<std::size_t>(
      config_.maximum_candidate_count, 1, 128);
  config_.maximum_beam_width = std::clamp<std::size_t>(config_.maximum_beam_width, 1, 16);
  config_.minimum_accuracy_meters = std::max(1.0, config_.minimum_accuracy_meters);
  config_.maximum_accuracy_meters = std::max(
      config_.minimum_accuracy_meters, config_.maximum_accuracy_meters);
  config_.maximum_candidate_radius_meters = std::max(
      10.0, config_.maximum_candidate_radius_meters);
  config_.maximum_observation_gap_milliseconds = std::max<std::int64_t>(
      1'000, config_.maximum_observation_gap_milliseconds);
  config_.maximum_speed_meters_per_second = std::clamp(
      config_.maximum_speed_meters_per_second, 1.0, 60.0);
}

MatchResult RoadMatcher::update(
    const Observation& observation,
    const std::vector<DirectedEdgeCandidate>& candidates) {
  if (!validCoordinate(observation.coordinate) ||
      !std::isfinite(observation.horizontal_accuracy_meters) ||
      observation.horizontal_accuracy_meters < 0 ||
      observation.monotonic_time_milliseconds < 0 ||
      (observation.speed_meters_per_second &&
       (!std::isfinite(*observation.speed_meters_per_second) ||
        *observation.speed_meters_per_second < 0 ||
        *observation.speed_meters_per_second > config_.maximum_speed_meters_per_second)) ||
      (observation.course_degrees &&
       (!std::isfinite(*observation.course_degrees) ||
        *observation.course_degrees < 0 || *observation.course_degrees > 360))) {
    return resultWithoutMatch(MatchStatus::invalid_observation, "invalid_observation");
  }

  const bool hadPreviousObservation = previous_observation_.has_value();
  bool observation_gap_requires_reacquisition = false;
  if (previous_observation_) {
    const std::int64_t elapsed_milliseconds = observation.monotonic_time_milliseconds -
        previous_observation_->monotonic_time_milliseconds;
    if (elapsed_milliseconds <= 0) {
      reset();
      return resultWithoutMatch(MatchStatus::uncertain, "time_regression");
    }
    if (elapsed_milliseconds > config_.maximum_observation_gap_milliseconds) {
      reset();
      observation_gap_requires_reacquisition = true;
    }
  }

  if (observation.horizontal_accuracy_meters > config_.maximum_accuracy_meters) {
    reset();
    return resultWithoutMatch(MatchStatus::uncertain, "poor_accuracy");
  }
  if (candidates.empty()) {
    reset();
    return resultWithoutMatch(MatchStatus::out_of_coverage, "no_nearby_road");
  }
  if (candidates.size() > config_.maximum_candidate_count) {
    reset();
    return resultWithoutMatch(MatchStatus::uncertain, "candidate_limit");
  }

  const double maximum_lateral_distance_meters = candidateRadiusMeters(
      observation.horizontal_accuracy_meters);
  std::vector<Hypothesis> projected_candidates;
  projected_candidates.reserve(candidates.size());
  for (const DirectedEdgeCandidate& candidate : candidates) {
    const auto projection = projectCandidate(observation, candidate);
    if (!projection || projection->lateral_distance_meters > maximum_lateral_distance_meters) {
      continue;
    }
    projected_candidates.push_back(Hypothesis{
        candidate,
        projection->position_along_edge_meters,
        projection->lateral_distance_meters,
        projection->course_degrees,
        emissionScore(observation, *projection, config_.minimum_accuracy_meters),
    });
  }

  if (projected_candidates.empty()) {
    reset();
    return resultWithoutMatch(MatchStatus::out_of_coverage, "no_road_within_radius");
  }

  bool has_connected_transition = false;
  if (!observation_gap_requires_reacquisition && previous_observation_ && !hypotheses_.empty()) {
    std::vector<Hypothesis> connected_candidates;
    connected_candidates.reserve(projected_candidates.size());
    for (Hypothesis& current : projected_candidates) {
      double best_transition_score = std::numeric_limits<double>::infinity();
      for (const Hypothesis& previous : hypotheses_) {
        double transition_penalty = 0;
        if (!isPlausibleTransition(
                config_, *previous_observation_, observation,
                previous.candidate, previous.position_along_edge_meters,
                previous.course_degrees, current.candidate,
                current.position_along_edge_meters, transition_penalty)) {
          continue;
        }
        best_transition_score = std::min(best_transition_score,
                                         previous.score * 0.65 + transition_penalty);
      }
      if (std::isfinite(best_transition_score)) {
        current.score += best_transition_score;
        connected_candidates.push_back(std::move(current));
        has_connected_transition = true;
      }
    }
    if (has_connected_transition) {
      projected_candidates = std::move(connected_candidates);
    } else {
      hypotheses_.clear();
    }
  }

  std::sort(projected_candidates.begin(), projected_candidates.end(),
            [](const Hypothesis& first, const Hypothesis& second) {
              if (first.score != second.score) return first.score < second.score;
              return first.candidate.edge_id < second.candidate.edge_id;
            });

  const double best_score = projected_candidates.front().score;
  for (Hypothesis& candidate : projected_candidates) candidate.score -= best_score;
  if (projected_candidates.size() > config_.maximum_beam_width) {
    projected_candidates.resize(config_.maximum_beam_width);
  }
  hypotheses_ = projected_candidates;
  previous_observation_ = observation;

  const Hypothesis& best_candidate = hypotheses_.front();
  const double score_margin = hypotheses_.size() > 1
      ? hypotheses_[1].score
      : std::numeric_limits<double>::infinity();
  const PositionMatchQuality candidate_position_quality = positionQuality(
      best_candidate.lateral_distance_meters, observation.horizontal_accuracy_meters);
  const bool has_stable_continuity = has_connected_transition && hypotheses_.size() > 0;
  const bool position_is_ambiguous = score_margin < kStableScoreMargin;
  const bool candidate_position_is_usable =
      candidate_position_quality == PositionMatchQuality::high ||
      candidate_position_quality == PositionMatchQuality::medium;

  MatchResult result;
  result.status = has_stable_continuity && candidate_position_is_usable && !position_is_ambiguous
      ? MatchStatus::matched
      : hadPreviousObservation && !observation_gap_requires_reacquisition
          ? MatchStatus::uncertain
          : MatchStatus::acquiring;
  if (!has_stable_continuity && result.status == MatchStatus::acquiring) {
    result.reason = observation_gap_requires_reacquisition ? "observation_gap" : "acquiring";
  }
  else if (!has_stable_continuity) result.reason = "no_connected_transition";
  else if (!candidate_position_is_usable) result.reason = "weak_position_match";
  else if (position_is_ambiguous) result.reason = "competing_candidates";
  else result.reason = "stable_match";
  result.position_quality = candidate_position_quality;
  result.forward_path_quality = position_is_ambiguous
      ? ForwardPathQuality::ambiguous
      : best_candidate.candidate.predictable
          ? best_candidate.candidate.forward_path_quality
          : ForwardPathQuality::unavailable;
  result.profile_quality = result.status == MatchStatus::matched &&
              best_candidate.candidate.predictable
      ? best_candidate.candidate.profile_quality
      : ProfileQuality::unavailable;
  result.matched_edge_id = best_candidate.candidate.edge_id;
  result.matched_segment_id = best_candidate.candidate.segment_id;
  result.corridor_id = best_candidate.candidate.corridor_id;
  result.position_along_edge_meters = best_candidate.position_along_edge_meters;
  result.lateral_distance_meters = best_candidate.lateral_distance_meters;
  if (result.status == MatchStatus::matched && best_candidate.candidate.predictable &&
      best_candidate.candidate.corridor_id &&
      best_candidate.candidate.corridor_length_meters > 0) {
    const double position_along_corridor_meters =
        best_candidate.candidate.corridor_start_distance_meters +
        best_candidate.position_along_edge_meters;
    result.position_along_corridor_meters = position_along_corridor_meters;
    if (best_candidate.candidate.profile_quality == ProfileQuality::complete) {
      result.profile_distance_to_boundary_meters = std::max(
          0.0,
          best_candidate.candidate.corridor_length_meters - position_along_corridor_meters);
    }
  }
  result.candidate_score_margin = std::isfinite(score_margin) ? score_margin : 1'000.0;
  return result;
}

void RoadMatcher::reset() {
  hypotheses_.clear();
  previous_observation_.reset();
}

double RoadMatcher::candidateRadiusMeters(double horizontal_accuracy_meters) const {
  if (!std::isfinite(horizontal_accuracy_meters) || horizontal_accuracy_meters < 0) {
    return 0;
  }
  return std::min(config_.maximum_candidate_radius_meters,
                  std::max(20.0, horizontal_accuracy_meters * 2 + 10.0));
}

const char* toString(MatchStatus value) {
  switch (value) {
    case MatchStatus::acquiring: return "acquiring";
    case MatchStatus::matched: return "matched";
    case MatchStatus::uncertain: return "uncertain";
    case MatchStatus::out_of_coverage: return "out_of_coverage";
    case MatchStatus::invalid_observation: return "invalid_observation";
  }
  return "invalid_observation";
}

const char* toString(PositionMatchQuality value) {
  switch (value) {
    case PositionMatchQuality::unavailable: return "unavailable";
    case PositionMatchQuality::low: return "low";
    case PositionMatchQuality::medium: return "medium";
    case PositionMatchQuality::high: return "high";
  }
  return "unavailable";
}

const char* toString(ForwardPathQuality value) {
  switch (value) {
    case ForwardPathQuality::unavailable: return "unavailable";
    case ForwardPathQuality::ambiguous: return "ambiguous";
    case ForwardPathQuality::known_to_boundary: return "known_to_boundary";
    case ForwardPathQuality::inferred_to_boundary: return "inferred_to_boundary";
  }
  return "unavailable";
}

const char* toString(ProfileQuality value) {
  switch (value) {
    case ProfileQuality::unavailable: return "unavailable";
    case ProfileQuality::partial: return "partial";
    case ProfileQuality::complete: return "complete";
  }
  return "unavailable";
}

}
