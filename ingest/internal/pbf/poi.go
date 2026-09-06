package pbf

// Point-of-interest selection.
//
// "Everything named with a POI tag" is 332,648 features for Czechia alone, and
// the bulk is noise that would bury real results. The top of that distribution
// (cmd/poistat):
//
//	public_transport=platform   59,545   one per bus-stop platform, all sharing
//	                                     the stop's name
//	tourism=information         56,930   hiking guideposts and notice boards
//	public_transport=stop_position 13,421
//	amenity=parcel_locker       11,218   Zasilkovna/Alza boxes
//	historic=yes                 6,114   unclassified
//	amenity=parking              3,218   mostly literally named "Parkoviste"
//	historic=wayside_shrine      2,307   plus 1,284 wayside_cross, roadside crosses
//	amenity=atm                  1,791
//
// So: an allowlist of keys with per-key exclusion of the values that are
// furniture rather than destinations. The test is whether a person would
// plausibly type the name into a search box.

// Tags that can make a named feature a POI; the first match is the category.
var poiKeys = []string{
	"amenity", "shop", "tourism", "leisure", "historic", "office",
	"healthcare", "craft", "railway", "aeroway", "public_transport", "man_made",
	"natural", "waterway", "mountain_pass",
}

// Per key, the values that are map furniture. Absent means included.
var excluded = map[string]map[string]bool{
	"amenity": {
		"parcel_locker": true, "atm": true, "charging_station": true,
		"parking": true, "parking_space": true, "parking_entrance": true,
		"bench": true, "waste_basket": true, "waste_disposal": true,
		"recycling": true, "vending_machine": true, "bicycle_parking": true,
		"bicycle_repair_station": true, "motorcycle_parking": true,
		"shelter": true, "drinking_water": true, "toilets": true,
		"hunting_stand": true, "grit_bin": true, "post_box": true,
		"telephone": true, "clock": true, "fountain": true, "bbq": true,
		"water_point": true, "fire_hydrant": true, "street_lamp": true,
		"lounger": true, "photo_booth": true, "device_charging_station": true,
	},
	// Guideposts and notice boards: 56,930 in Czechia.
	"tourism": {"information": true},
	// The station, not its platforms.
	"public_transport": {
		"platform": true, "stop_position": true, "stop_area": true,
		"stop_area_group": true,
	},
	"railway": {
		"rail": true, "platform": true, "platform_edge": true, "stop": true,
		"switch": true, "signal": true, "level_crossing": true, "crossing": true,
		"buffer_stop": true, "milestone": true, "razed": true, "abandoned": true,
		"disused": true, "construction": true, "proposed": true, "yard": true,
		"turntable": true, "traverser": true, "derail": true, "tram": true,
		"subway": true, "narrow_gauge": true, "light_rail": true,
		"preserved": true, "monorail": true, "funicular": true, "spur": true,
		"siding": true, "crossover": true, "owner_change": true,
	},
	"historic": {
		"yes": true, "wayside_shrine": true, "wayside_cross": true,
		"boundary_stone": true, "milestone": true, "survey_point": true,
	},
	"leisure": {
		"pitch": true, "playground": true, "fitness_station": true,
		"picnic_table": true, "slipway": true, "firepit": true,
		"bleachers": true, "outdoor_seating": true, "common": true,
		"bandstand": true,
	},
	"man_made": {
		"monitoring_station": true, "surveillance": true, "pipeline": true,
		"storage_tank": true, "mast": true, "antenna": true, "utility_pole": true,
		"street_cabinet": true, "manhole": true, "pole": true, "cutline": true,
		"embankment": true, "adit": true, "petroleum_well": true,
		"silo": true, "gasometer": true, "flagpole": true, "cairn": true,
		"survey_point": true, "beacon": true, "crane": true, "works": true,
	},
	"aeroway": {
		"runway": true, "taxiway": true, "apron": true, "hangar": true,
		"holding_position": true, "parking_position": true, "navigationaid": true,
		"windsock": true, "gate": true,
	},
	"shop": {"vacant": true, "no": true},
	// Named natural features are destinations, and the region is alpine —
	// leaving them out made "Matterhorn" a tram stop in the Netherlands. What
	// is excluded is ground cover, which is named only incidentally.
	"natural": {
		"tree": true, "tree_row": true, "scrub": true, "grassland": true,
		"heath": true, "wetland": true, "rock": true, "stone": true,
		"sand": true, "coastline": true, "shingle": true, "bare_rock": true,
		"scree": true, "hedge": true, "earth_bank": true, "shrub": true,
		"tree_stump": true, "gully": true, "sinkhole": true, "crevasse": true,
	},
	// Rivers and canals are landmarks; drainage is not.
	"waterway": {
		"stream": true, "ditch": true, "drain": true, "weir": true,
		"lock_gate": true, "riverbank": true, "fish_pass": true,
		"turning_point": true, "water_point": true, "fuel": true,
	},
}

// Whether tags describe a searchable POI, and its category. It must be named:
// OSM has millions of unnamed shops and nobody can look one up.
func isPOI(t map[string]string) (category string, ok bool) {
	if t["name"] == "" {
		return "", false
	}
	// Mapped as gone.
	if t["disused"] == "yes" || t["abandoned"] == "yes" ||
		t["demolished"] == "yes" || t["was"] != "" {
		return "", false
	}
	for _, k := range poiKeys {
		v := t[k]
		if v == "" || v == "no" {
			continue
		}
		if excluded[k][v] {
			continue
		}
		return k + "=" + v, true
	}
	return "", false
}
