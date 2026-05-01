/* House Price Predictor (offline)
   Weighted model: size + location dominate; amenities/environment are secondary modifiers.

   Quick test scenarios (sanity targets; will vary with modifiers):
   1) Budget flat:
      - Tier: Outskirts, City: Indore, Size: 550, 1BHK/1Bath, Floor 1/4, Age 18,
        Unfurnished, Parking No, Metro >5km, School 1–5km, Hospital 1–5km, AQI Moderate, Road Interior
      - Expected: ~₹20L–₹45L
   2) Mid-range apartment:
      - Tier: Suburban, City: Pune, Size: 1050, 2BHK/2Bath, Floor 7/15, Age 6,
        Semi, Parking Yes, Metro 1–5km, School <1km, Hospital 1–5km, AQI Moderate, Road Main
      - Expected: ~₹0.9Cr–₹1.7Cr
   3) Luxury villa:
      - Tier: Prime, City: Mumbai, Size: 3200, 4BHK/4Bath, Floor 0/2, Age 2,
        Fully, Parking Yes, Metro <1km, School <1km, Hospital <1km, AQI Moderate, Road Highway
      - Expected: ~₹6Cr–₹14Cr
*/

const CITY_BASE_PSF_INR = {
  "Mumbai": 21000,
  "Delhi NCR": 12000,
  "Bengaluru": 10500,
  "Hyderabad": 7500,
  "Chennai": 9000,
  "Kolkata": 7000,
  "Pune": 9500,
  "Ahmedabad": 6500,
  "Jaipur": 5200,
  "Lucknow": 5000,
  "Indore": 4700,
  "Surat": 4800,
  "Coimbatore": 5200,
  "Kochi": 6500,
  "Chandigarh": 7200,
  "Bhopal": 4500,
  "Nagpur": 4300,
  "Visakhapatnam": 5200,
};

const TIER_MULTIPLIER = {
  Prime: 1.35,
  Urban: 1.15,
  Suburban: 1.0,
  Outskirts: 0.82,
};

const FURNISHING_MULT = {
  Unfurnished: 1.0,
  Semi: 1.05,
  Fully: 1.10,
};

const PARKING_MULT = { Yes: 1.03, No: 0.985 };

const DIST_MULT = {
  "<1km": 1.035,
  "1–5km": 1.015,
  ">5km": 0.985,
};

const AQI_MULT = { Good: 1.02, Moderate: 1.0, Poor: 0.965 };

const ROAD_MULT = { Highway: 1.03, Main: 1.015, Interior: 0.985 };

function el(id) {
  return document.getElementById(id);
}

function getRadioValue(name) {
  const checked = document.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
  return checked ? checked.value : "";
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function inrCompact(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);

  if (abs >= 1e7) {
    const cr = abs / 1e7;
    const crStr = cr >= 10 ? cr.toFixed(1) : cr.toFixed(2);
    return `${sign}₹${trimZeros(crStr)} Cr`;
  }

  if (abs >= 1e5) {
    const l = abs / 1e5;
    const lStr = l >= 10 ? l.toFixed(1) : l.toFixed(2);
    return `${sign}₹${trimZeros(lStr)} L`;
  }

  return `${sign}${formatINR(abs)}`;
}

function trimZeros(s) {
  return s.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0$/, "$1");
}

function formatINR(n) {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function pct(n) {
  return `${Math.round(n * 100)}%`;
}

function computeFloorMultiplier(floorNo, totalFloors) {
  // Mild premium for mid-high floors (views/air), mild discount for extreme top (heat/maintenance).
  const total = Math.max(1, totalFloors);
  const f = clamp(floorNo, 0, total);
  const ratio = total === 1 ? 0 : f / total;
  const premium = 1 + 0.03 * Math.sin(Math.PI * ratio); // 1.00 .. 1.03
  const topPenalty = ratio > 0.92 ? 0.99 : 1.0;
  const groundNudge = f === 0 ? 0.995 : 1.0;
  return premium * topPenalty * groundNudge;
}

function computeAgeMultiplier(ageYears) {
  // Depreciation then plateau (renovations/land value support).
  const age = clamp(ageYears, 0, 80);
  const dep = 1 - Math.min(0.18, age * 0.007); // up to -18%
  const plateau = age > 25 ? 1.01 : 1.0;
  return dep * plateau;
}

function computeSizeElasticity(sizeSqft) {
  // Diminishing returns on very large size for ₹/sqft; keeps villas plausible.
  const s = clamp(sizeSqft, 300, 12000);
  // 800 sqft -> ~1.00, 300 sqft -> ~0.96, 3000 sqft -> ~0.91, 8000 sqft -> ~0.84
  return 1 - 0.045 * Math.log10(s / 800 + 1);
}

function validate(values) {
  const errors = [];
  const requiredSelects = ["tier", "city", "furnishing", "metro", "school", "hospital", "aqi", "road"];
  for (const k of requiredSelects) {
    if (!values[k]) errors.push(`${labelFor(k)} is required.`);
  }

  if (!Number.isFinite(values.sizeSqft) || values.sizeSqft < 300 || values.sizeSqft > 12000) {
    errors.push("House size must be between 300 and 12,000 sq ft.");
  }
  if (!Number.isFinite(values.bedrooms) || values.bedrooms < 1 || values.bedrooms > 10) {
    errors.push("Bedrooms must be between 1 and 10.");
  }
  if (!Number.isFinite(values.bathrooms) || values.bathrooms < 1 || values.bathrooms > 10) {
    errors.push("Bathrooms must be between 1 and 10.");
  }
  if (!Number.isFinite(values.totalFloors) || values.totalFloors < 1 || values.totalFloors > 150) {
    errors.push("Total floors must be between 1 and 150.");
  }
  if (!Number.isFinite(values.floorNo) || values.floorNo < 0 || values.floorNo > 150) {
    errors.push("Floor number must be between 0 and 150.");
  }
  if (Number.isFinite(values.floorNo) && Number.isFinite(values.totalFloors) && values.floorNo > values.totalFloors) {
    errors.push("Floor number cannot be greater than total floors.");
  }
  if (!Number.isFinite(values.ageYears) || values.ageYears < 0 || values.ageYears > 80) {
    errors.push("Property age must be between 0 and 80 years.");
  }

  // Soft realism checks (warnings become hard errors if too extreme)
  if (Number.isFinite(values.bedrooms) && Number.isFinite(values.sizeSqft)) {
    const minReasonable = values.bedrooms * 180;
    if (values.sizeSqft < minReasonable) {
      errors.push(`Size looks too small for ${values.bedrooms} bedroom(s). Increase size or reduce bedrooms.`);
    }
  }
  if (Number.isFinite(values.bathrooms) && Number.isFinite(values.bedrooms)) {
    if (values.bathrooms > values.bedrooms + 2) {
      errors.push("Bathrooms look unusually high for the number of bedrooms.");
    }
  }
  return errors;
}

function labelFor(key) {
  const map = {
    tier: "Location / Neighborhood tier",
    city: "City",
    sizeSqft: "House size",
    bedrooms: "Bedrooms",
    bathrooms: "Bathrooms",
    floorNo: "Floor number",
    totalFloors: "Total floors",
    ageYears: "Property age",
    furnishing: "Furnishing status",
    parking: "Parking availability",
    metro: "Proximity to metro",
    school: "Proximity to school",
    hospital: "Proximity to hospital",
    aqi: "Air Quality Index zone",
    road: "Road connectivity",
  };
  return map[key] || key;
}

function buildWhyTop3(contribs) {
  return contribs
    .slice()
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 3);
}

function estimate(values) {
  const basePsf = CITY_BASE_PSF_INR[values.city] ?? 6500;
  const tierMult = TIER_MULTIPLIER[values.tier] ?? 1;

  // Primary drivers
  const sizeElastic = computeSizeElasticity(values.sizeSqft);
  const corePsf = basePsf * tierMult * sizeElastic;

  // Bedrooms/bathrooms: small adjustments (layout/value capture)
  const bedAdj = 1 + clamp((values.bedrooms - 2) * 0.012, -0.02, 0.06);
  const bathAdj = 1 + clamp((values.bathrooms - Math.max(1, values.bedrooms)) * 0.01, -0.02, 0.04);

  const floorMult = computeFloorMultiplier(values.floorNo, values.totalFloors);
  const ageMult = computeAgeMultiplier(values.ageYears);

  const furnishingMult = FURNISHING_MULT[values.furnishing] ?? 1;
  const parkingMult = PARKING_MULT[values.parking] ?? 1;

  const proximityMult =
    (DIST_MULT[values.metro] ?? 1) *
    (DIST_MULT[values.school] ?? 1) *
    (DIST_MULT[values.hospital] ?? 1);

  const aqiMult = AQI_MULT[values.aqi] ?? 1;
  const roadMult = ROAD_MULT[values.road] ?? 1;

  // Final multiplier: cap extremes to keep outputs plausible.
  let mult = bedAdj * bathAdj * floorMult * ageMult * furnishingMult * parkingMult * proximityMult * aqiMult * roadMult;
  mult = clamp(mult, 0.78, 1.52);

  const psf = corePsf * mult;
  let price = psf * values.sizeSqft;

  // City sanity caps (keeps extreme combos in check)
  const cityCapMult = values.city === "Mumbai" ? 1.35 : values.city === "Delhi NCR" ? 1.25 : 1.18;
  const minPrice = values.sizeSqft * basePsf * 0.62; // strong discount floor
  const maxPrice = values.sizeSqft * basePsf * tierMult * cityCapMult * 1.55; // premium ceiling
  price = clamp(price, minPrice, maxPrice);

  const rangeLow = price * 0.90;
  const rangeHigh = price * 1.10;

  function priceForSize(sizeSqft) {
    const se = computeSizeElasticity(sizeSqft);
    const cpsf = basePsf * tierMult * se;
    const p = cpsf * mult;
    let pr = p * sizeSqft;
    const minP = sizeSqft * basePsf * 0.62;
    const maxP = sizeSqft * basePsf * tierMult * cityCapMult * 1.55;
    pr = clamp(pr, minP, maxP);
    return pr;
  }

  const baseTierPsf = basePsf * tierMult * sizeElastic;
  const sizeImpact = price - priceForSize(900);
  const impacts = [
    { label: `City base rate (${values.city})`, impact: (basePsf - 6500) * values.sizeSqft },
    { label: `Neighborhood tier (${values.tier})`, impact: (tierMult - 1) * basePsf * values.sizeSqft },
    { label: `Size (${values.sizeSqft.toLocaleString("en-IN")} sq ft)`, impact: sizeImpact }, // vs 900 sq ft baseline
    { label: `Age (${values.ageYears} years)`, impact: (ageMult - 1) * baseTierPsf * values.sizeSqft },
    { label: `Floor (${values.floorNo}/${values.totalFloors})`, impact: (floorMult - 1) * baseTierPsf * values.sizeSqft },
    { label: `Furnishing (${values.furnishing})`, impact: (furnishingMult - 1) * baseTierPsf * values.sizeSqft },
    { label: `Parking (${values.parking})`, impact: (parkingMult - 1) * baseTierPsf * values.sizeSqft },
    {
      label: `Transit/social proximity (metro/school/hospital)`,
      impact: (proximityMult - 1) * baseTierPsf * values.sizeSqft,
    },
    { label: `AQI zone (${values.aqi})`, impact: (aqiMult - 1) * baseTierPsf * values.sizeSqft },
    { label: `Road connectivity (${values.road})`, impact: (roadMult - 1) * baseTierPsf * values.sizeSqft },
  ];

  const whyTop3 = buildWhyTop3(impacts);

  return {
    price,
    psf,
    rangeLow,
    rangeHigh,
    whyTop3,
  };
}

function readValues() {
  return {
    tier: el("tier").value,
    city: el("city").value,
    sizeSqft: Number(el("sizeSqft").value),
    bedrooms: Number(el("bedrooms").value),
    bathrooms: Number(el("bathrooms").value),
    floorNo: Number(el("floorNo").value),
    totalFloors: Number(el("totalFloors").value),
    ageYears: Number(el("ageYears").value),
    furnishing: el("furnishing").value,
    parking: getRadioValue("parking"),
    metro: el("metro").value,
    school: el("school").value,
    hospital: el("hospital").value,
    aqi: el("aqi").value,
    road: el("road").value,
  };
}

function renderErrors(errors) {
  const errorBox = el("errorBox");
  const errorList = el("errorList");
  errorList.innerHTML = "";

  if (!errors.length) {
    errorBox.hidden = true;
    return;
  }

  for (const msg of errors) {
    const li = document.createElement("li");
    li.textContent = msg;
    errorList.appendChild(li);
  }
  errorBox.hidden = false;
}

function renderResult(result) {
  el("priceOut").textContent = inrCompact(result.price);
  el("psfOut").textContent = formatINR(result.psf) + " / sq ft";
  el("rangeOut").textContent = `Confidence range: ${inrCompact(result.rangeLow)} – ${inrCompact(result.rangeHigh)} (±10%)`;

  const whyList = el("whyList");
  whyList.innerHTML = "";
  for (const item of result.whyTop3) {
    const li = document.createElement("li");
    const sign = item.impact >= 0 ? "+" : "−";
    const abs = Math.abs(item.impact);
    li.textContent = `${item.label} (${sign}${inrCompact(abs)})`;
    whyList.appendChild(li);
  }

  el("resultsPlaceholder").hidden = true;
  const results = el("results");
  results.dataset.visible = "false";
  // next frame for transition
  requestAnimationFrame(() => {
    results.dataset.visible = "true";
  });
}

function attachLiveConstraints() {
  const floorNo = el("floorNo");
  const totalFloors = el("totalFloors");
  function sync() {
    const tf = Number(totalFloors.value);
    if (Number.isFinite(tf) && tf > 0) floorNo.max = String(tf);
  }
  totalFloors.addEventListener("input", sync);
  sync();
}

function init() {
  const form = el("predictForm");
  const resetBtn = el("resetBtn");

  attachLiveConstraints();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = readValues();
    const errors = validate(values);
    renderErrors(errors);
    if (errors.length) {
      el("results").dataset.visible = "false";
      el("resultsPlaceholder").hidden = false;
      el("resultsPlaceholder").textContent = "Fix the highlighted issues above to see the estimate.";
      return;
    }
    const result = estimate(values);
    renderResult(result);
  });

  resetBtn.addEventListener("click", () => {
    form.reset();
    // restore defaults for stepper inputs since reset() uses markup defaults
    el("bedrooms").value = "2";
    el("bathrooms").value = "2";
    el("floorNo").value = "2";
    el("totalFloors").value = "10";
    el("ageYears").value = "5";
    renderErrors([]);
    el("results").dataset.visible = "false";
    el("resultsPlaceholder").hidden = false;
    el("resultsPlaceholder").innerHTML =
      'Fill in the details and hit <strong>Estimate Price</strong> to see the result.';
  });
}

document.addEventListener("DOMContentLoaded", init);

