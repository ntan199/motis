#include "motis/endpoints/raptor_n_to_all.h"

#include <algorithm>
#include <chrono>
#include <unordered_map>
#include <vector>

#include "utl/verify.h"

#include "net/bad_request_exception.h"
#include "net/too_many_exception.h"

#include "nigiri/common/delta_t.h"
#include "nigiri/routing/limits.h"
#include "nigiri/routing/raptor_n_to_all.h"
#include "nigiri/routing/query.h"
#include "nigiri/types.h"

#include "motis-api/motis-api.h"
#include "motis/endpoints/routing.h"
#include "motis/gbfs/routing_data.h"
#include "motis/metrics_registry.h"
#include "motis/place.h"
#include "motis/server.h"
#include "motis/timetable/modes_to_clasz_mask.h"

namespace motis::ep {

namespace n = nigiri;

api::NToAll raptor_n_to_all::operator()(boost::urls::url_view const& url) const {
  metrics_->routing_requests_.Increment();

  auto const api_version = get_api_version(url);
  auto const max_travel_minutes =
      config_.get_limits().onetoall_max_travel_minutes_;
  auto const query = api::nToAll_params{url.params()};

  // Cap maxMatchingDistance at server limit (mirrors one_to_all.cc).
  auto const max_matching_distance =
      std::min(query.maxMatchingDistance_,
               config_.get_limits().max_max_matching_distance_);

  // --- Validation ---
  utl::verify<net::bad_request_exception>(
      !query.origins_.empty(), "at least one origin required");
  utl::verify<net::too_many_exception>(
      query.origins_.size() <= 10U,
      "too many origins: {} > 10", query.origins_.size());
  utl::verify<net::too_many_exception>(
      query.maxTravelTime_ <= max_travel_minutes,
      "maxTravelTime too large ({} > {}). The server admin can change "
      "this limit in config.yml with 'onetoall_max_travel_minutes'. "
      "See documentation for details.",
      query.maxTravelTime_, max_travel_minutes);
  if (query.maxTransfers_.has_value()) {
    utl::verify<net::bad_request_exception>(
        query.maxTransfers_ >= 0U,
        "maxTransfers < 0: {}", *query.maxTransfers_);
    utl::verify<net::too_many_exception>(
        query.maxTransfers_ <= n::routing::kMaxTransfers,
        "maxTransfers > {}: {}", n::routing::kMaxTransfers,
        *query.maxTransfers_);
  }

  // --- Setup (mirrors one_to_all.cc exactly) ---
  auto const time = std::chrono::time_point_cast<std::chrono::minutes>(
      *query.time_.value_or(openapi::now()));
  auto const max_travel_time = n::duration_t{query.maxTravelTime_};

  auto const r = routing{
      config_, w_,        l_,      pl_,      elevations_,  &tt_,    nullptr,
      &tags_,  loc_tree_, fa_,     matches_, way_matches_, rt_,     nullptr,
      gbfs_,   nullptr,   nullptr, nullptr,  nullptr,      metrics_};
  auto gbfs_rd = gbfs::gbfs_routing_data{w_, l_, gbfs_};
  auto const osr_params = get_osr_parameters(query);

  auto const one_modes    = deduplicate(query.preTransitModes_);
  auto const one_max_time = std::min(
      std::chrono::seconds{query.maxPreTransitTime_},
      std::min(
          std::chrono::duration_cast<std::chrono::seconds>(max_travel_time),
          std::chrono::seconds{
              config_.get_limits()
                  .street_routing_max_prepost_transit_seconds_}));

  auto const prf_idx = static_cast<n::profile_idx_t>(
      query.useRoutedTransfers_
          ? (query.pedestrianProfile_ ==
                     api::PedestrianProfileEnum::WHEELCHAIR
                 ? 2U
                 : 1U)
          : 0U);

  // --- Resolve each origin ---
  // For each resolved stop we register it in stop_to_origin_idx so that
  // ANY stop that raptor_n_to_all could use as an owner maps back to the
  // correct origin index. This fixes null originIndex when the algorithm
  // picks a non-representative stop (e.g. via equivalent stop expansion).
  auto prepare_stats      = std::map<std::string, std::uint64_t>{};
  auto resolved_places    = std::vector<api::Place>{};
  auto origin_locs        = std::vector<n::location_idx_t>{};
  auto origin_locs2        = std::vector<n::location_idx_t>{};
  auto all_starts         = std::vector<n::routing::offset>{};
  auto all_td_starts      = n::routing::td_offsets_t{};
  auto stop_to_origin_idx =
      std::unordered_map<n::location_idx_t, std::int64_t>{};

  for (auto const& origin_str : query.origins_) {
    auto const place      = get_place(&tt_, &tags_, origin_str);
    auto const origin_idx = static_cast<std::int64_t>(origin_locs.size());

    auto starts = r.get_offsets(
        nullptr, place, osr::direction::kForward, one_modes,
        rental_options{}, osr_params, query.pedestrianProfile_,
        query.elevationCosts_, one_max_time,
        max_matching_distance, gbfs_rd, prepare_stats);

    auto td_starts = r.get_td_offsets(
        nullptr, nullptr, place, osr::direction::kForward, one_modes,
        osr_params, query.pedestrianProfile_, query.elevationCosts_,
        max_matching_distance, one_max_time, time, prepare_stats);

    // Register ALL resolved stops for this origin.
    // raptor_n_to_all may set cell.owner_ to any of these stops,
    // not just starts.front(). Registering all of them prevents nullopt.
    for (auto const& s : starts) {
      stop_to_origin_idx.emplace(s.target(), origin_idx);
    }

    // Representative stop — closest resolved stop, used as seed identity.
    origin_locs.push_back(starts.empty()
                               ? n::location_idx_t::invalid()
                               : starts.front().target());

    for (auto& s : starts) {
      all_starts.push_back(std::move(s));
      origin_locs2.push_back(std::move(s.target()));
    }
    for (auto& [l, td] : td_starts) {
      auto& dest = all_td_starts[l];
      dest.insert(dest.end(), td.begin(), td.end());
    }

    resolved_places.push_back(bwd_compat_lvl_adjust(
        to_place(&tt_, &tags_, w_, pl_, matches_, ae_, tz_, {}, place),
        api_version));
  }

  utl::verify<net::bad_request_exception>(
      std::any_of(origin_locs.begin(), origin_locs.end(),
                  [](auto const l) {
                    return l != n::location_idx_t::invalid();
                  }),
      "none of the origins could be matched to a transit stop");

  // --- Build the shared nigiri query (mirrors one_to_all.cc) ---
  auto q = n::routing::query{
      .start_time_      = time,
      .start_match_mode_ =
          r.is_osr_loaded()
              ? n::routing::location_match_mode::kIntermodal
              : n::routing::location_match_mode::kEquivalent,
      .start_           = std::move(all_starts),
      .td_start_        = std::move(all_td_starts),
      .max_transfers_   = static_cast<std::uint8_t>(
          query.maxTransfers_.value_or(n::routing::kMaxTransfers)),
      .max_travel_time_ = max_travel_time,
      .prf_idx_         = prf_idx,
      .allowed_claszes_ = to_clasz_mask(query.transitModes_),
      .require_bike_transport_    = query.requireBikeTransport_,
      .require_car_transport_     = query.requireCarTransport_,
      .no_compulsory_reservation_ = query.noCompulsoryReservation_,
      .transfer_time_settings_ = n::routing::transfer_time_settings{
          .default_ = (query.minTransferTime_ == 0 &&
                       query.additionalTransferTime_ == 0 &&
                       query.transferTimeFactor_ == 1.0),
          .min_transfer_time_ = n::duration_t{query.minTransferTime_},
          .additional_time_   = n::duration_t{query.additionalTransferTime_},
          .factor_ = static_cast<float>(query.transferTimeFactor_)},
  };

  if (tt_.locations_.footpaths_out_.at(q.prf_idx_).empty()) {
    q.prf_idx_ = 0U;
  }

  // Collect valid representative origin stops for raptor_n_to_all.
  auto valid_origins = std::vector<n::location_idx_t>{};
  valid_origins.reserve(origin_locs.size());
  for (auto const l : origin_locs) {
    if (l != n::location_idx_t::invalid()) {
      valid_origins.push_back(l);
    }
  }

  auto const* rtt = rt_ ? rt_->rtt_.get() : nullptr;

  auto const result = n::routing::raptor_n_to_all(
      tt_, rtt, origin_locs2, time, q);

  // --- Assemble response ---
  auto const max_results  = config_.get_limits().onetoall_max_results_;
  auto const unreachable  = n::kInvalidDelta<n::direction::kForward>;
  auto const& round_times = result.state_.get_round_times<n::via_offset_t{0U}>();

  // Use get_best<0> + bitvec to iterate only reached stops,
  // mirroring one_to_all.cc's approach.
  auto reachable = n::bitvec{tt_.n_locations()};
  for (auto i = 0U; i != tt_.n_locations(); ++i) {
    if (result.state_.get_best<0>()[i][0] != unreachable) {
      reachable.set(i);
    }
  }

  auto const max_results_count = max_results;
  utl::verify<net::too_many_exception>(
      reachable.count() <= max_results_count,
      "too many results: {} > {}", reachable.count(), max_results_count);

  auto all = std::vector<api::ReachablePlace>{};
  all.reserve(reachable.count());

  reachable.for_each_set_bit([&](auto const i) {
    auto const l     = n::location_idx_t{i};
    auto const& cell = result.cell(l);

    // Find k — same semantics as one_to_all's ReachablePlace.
    auto k = std::int64_t{0};
    for (auto ki = 0U; ki <= q.max_transfers_ + 1U; ++ki) {
      if (round_times[ki][i][0] != unreachable) {
        k = static_cast<std::int64_t>(ki);
        break;
      }
    }

    // Look up origin index using ALL resolved stops (not just representatives).
    // This prevents null originIndex for stops owned by non-primary seeds.
    auto const origin_it  = stop_to_origin_idx.find(cell.owner_);
    auto const origin_idx =
        origin_it != stop_to_origin_idx.end()
            ? std::optional<std::int64_t>{origin_it->second}
            : std::nullopt;

    auto place = bwd_compat_lvl_adjust(
        to_place(&tt_, &tags_, w_, pl_, matches_, ae_, tz_, {},
                 tt_location{l}),
        api_version);
    place.arrival_ = time + cell.travel_time_;

    all.push_back(api::ReachablePlace{
        .place_       = std::move(place),
        .duration_    = static_cast<std::int64_t>(cell.travel_time_.count()),
        .k_           = k,
        .originIndex_ = origin_idx,
    });
  });

  return api::NToAll{
      .origins_ = std::move(resolved_places),
      .all_     = std::move(all),
  };
}

}  // namespace motis::ep
