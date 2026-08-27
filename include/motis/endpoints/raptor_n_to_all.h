#pragma once

#include "boost/url/url_view.hpp"

#include "motis-api/motis-api.h"
#include "motis/data.h"
#include "motis/fwd.h"

namespace motis::ep {

// ---------------------------------------------------------------------------
// raptor_n_to_all endpoint
//
// Multi-origin extension of one_to_all. Drives nigiri::routing::raptor_n_to_all
// in a single RAPTOR pass seeding all origins simultaneously, returning for
// each reachable stop the fastest travel time and the index of the origin
// that reaches it fastest (originIndex in the ReachablePlace response).
//
// All field names and types are identical to ep::one_to_all so that
// utl::init_from<raptor_n_to_all>(d) works without any extra wiring.
//
// Place at:  include/motis/endpoints/raptor_n_to_all.h
// Register in motis_instance.h:
//   #include "motis/endpoints/raptor_n_to_all.h"
//   GET<ep::raptor_n_to_all>("/api/v1/n-to-all", d);
// ---------------------------------------------------------------------------
struct raptor_n_to_all {
  api::NToAll operator()(boost::urls::url_view const&) const;

  config const& config_;
  osr::ways const* w_;
  osr::lookup const* l_;
  osr::platforms const* pl_;
  osr::elevation_storage const* elevations_;
  nigiri::timetable const& tt_;
  std::shared_ptr<rt> const& rt_;
  tag_lookup const& tags_;
  flex::flex_areas const* fa_;
  point_rtree<nigiri::location_idx_t> const* loc_tree_;
  platform_matches_t const* matches_;
  adr_ext const* ae_;
  tz_map_t const* tz_;
  way_matches_storage const* way_matches_;
  std::shared_ptr<gbfs::gbfs_data> const& gbfs_;
  metrics_registry* metrics_;
};

}  // namespace motis::ep
