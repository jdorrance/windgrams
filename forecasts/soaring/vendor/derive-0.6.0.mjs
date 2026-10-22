/* Vendored unchanged from @azohra/meteo.forecast 0.6.0 dist/derive.js.
MIT License

Copyright (c) 2026 Justin Watts

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { DRY_ADIABATIC_LAPSE_C_PER_M, normalizeDegrees, usableLiftTopM } from "@azohra/meteo.briefing/derive";
import { SITE_FORECAST_SCHEMA_VERSION } from "@azohra/meteo.briefing/contract";
//#region src/derive.ts
const SATURATED_DEPRESSION_C = .5;
function deriveSiteForecast(source, model, semantics) {
	const site = {
		id: source.siteId,
		name: source.siteName,
		latitude: source.latitude,
		longitude: source.longitude,
		modelElevationM: source.modelElevationM
	};
	if (source.siteTimeZone) site.timeZone = source.siteTimeZone;
	return {
		schemaVersion: SITE_FORECAST_SCHEMA_VERSION,
		model,
		run: {
			referenceTime: source.referenceTime,
			generatedAt: source.generatedAt
		},
		site,
		semantics,
		hours: source.hours.map((hour) => deriveHour(hour, source.modelElevationM))
	};
}
function deriveHour(source, modelElevationM) {
	const levels = source.levels.filter((level) => Number.isFinite(level.heightM) && level.heightM > modelElevationM + 20).sort((a, b) => a.heightM - b.heightM);
	const cloudBaseM = deriveCloudBaseM(source.temperatureC, source.dewPointDepressionC, modelElevationM, levels);
	const boundaryLayerDepthM = boundaryLayerDepth(source.temperatureC, modelElevationM, levels);
	const thermalVelocityMps = thermalVelocity(source.temperatureC, source.sensibleHeatFluxWm2, source.latentHeatFluxWm2, boundaryLayerDepthM, levels.length > 0 ? levels[0].pressureHpa : null);
	const usableLiftTopMValue = usableLiftTopM({
		modelElevationM,
		boundaryLayerTopM: boundaryLayerDepthM > 0 ? modelElevationM + boundaryLayerDepthM : null,
		thermalVelocityMps,
		cloudBaseM,
		levels
	});
	const surface = {
		seaLevelPressureHpa: source.seaLevelPressureHpa,
		temperatureC: source.temperatureC,
		dewPointC: source.temperatureC - source.dewPointDepressionC,
		windSpeedMps: Math.max(0, source.windSpeedMps),
		windDirectionDeg: normalizeDegrees(source.windDirectionDeg),
		cloudCoverPercent: clamp(source.cloudCoverPercent, 0, 100),
		precipitationMmHr: Math.max(0, source.precipitationMm),
		sensibleHeatFluxWm2: source.sensibleHeatFluxWm2,
		latentHeatFluxWm2: source.latentHeatFluxWm2
	};
	for (const [fieldName, sanitize] of OPTIONAL_SURFACE_FIELDS_IN_CONTRACT_ORDER) if (fieldName in source) surface[fieldName] = sanitize(source[fieldName]);
	const hour = {
		validAt: source.validAt,
		surface,
		levels: levels.map(deriveLevel),
		derived: {
			boundaryLayerTopM: boundaryLayerDepthM > 0 ? modelElevationM + boundaryLayerDepthM : null,
			thermalVelocityMps,
			cloudBaseM,
			usableLiftTopM: usableLiftTopMValue
		}
	};
	if (source.smoke !== void 0) hour.smoke = Object.fromEntries(Object.entries(source.smoke).map(([name, value]) => [name, Math.max(0, value)]));
	return hour;
}
const OPTIONAL_SURFACE_FIELDS_IN_CONTRACT_ORDER = [
	["windGustMps", (v) => Math.max(0, v)],
	["capeJkg", (v) => Math.max(0, v)],
	["cinJkg", (v) => Math.min(0, v)],
	["pblHeightM", (v) => Math.max(0, v)],
	["lowCloudPercent", (v) => clamp(v, 0, 100)],
	["midCloudPercent", (v) => clamp(v, 0, 100)],
	["highCloudPercent", (v) => clamp(v, 0, 100)]
];
function deriveLevel(level) {
	const derived = {
		pressureHpa: level.pressureHpa,
		heightM: level.heightM,
		temperatureC: level.temperatureC,
		dewPointC: level.temperatureC - level.dewPointDepressionC,
		windSpeedMps: Math.max(0, level.windSpeedMps),
		windDirectionDeg: normalizeDegrees(level.windDirectionDeg)
	};
	if (level.verticalVelocityPaS !== void 0) derived.verticalVelocityPaS = level.verticalVelocityPaS;
	if (level.cloudFractionPercent !== void 0) derived.cloudFractionPercent = clamp(level.cloudFractionPercent, 0, 100);
	return derived;
}
function deriveCloudBaseM(surfaceTemperatureC, dewPointDepressionC, modelElevationM, levels) {
	let cloudBaseM = modelElevationM + parcelLclAglM(surfaceTemperatureC, surfaceTemperatureC - dewPointDepressionC);
	const firstSaturatedM = firstSaturatedAltitudeM(dewPointDepressionC, modelElevationM, levels);
	if (firstSaturatedM !== null) cloudBaseM = Math.min(cloudBaseM, firstSaturatedM);
	return clampAltitude(cloudBaseM, modelElevationM);
}
function parcelLclAglM(temperatureC, dewPointC) {
	if (dewPointC >= temperatureC) return 0;
	const temperatureK = temperatureC + 273.15;
	const dewPointK = dewPointC + 273.15;
	const lclTemperatureK = 1 / (1 / (dewPointK - 56) + Math.log(temperatureK / dewPointK) / 800) + 56;
	return Math.max(0, (temperatureK - lclTemperatureK) / DRY_ADIABATIC_LAPSE_C_PER_M);
}
function firstSaturatedAltitudeM(surfaceDewPointDepressionC, modelElevationM, levels) {
	const profile = [[modelElevationM, surfaceDewPointDepressionC], ...levels.map((level) => [level.heightM, level.dewPointDepressionC])].filter(([, depression]) => Number.isFinite(depression));
	if (profile.length === 0) return null;
	if (profile[0][1] <= SATURATED_DEPRESSION_C) return profile[0][0];
	for (let index = 1; index < profile.length; index += 1) {
		const [belowM, belowC] = profile[index - 1];
		const [aboveM, aboveC] = profile[index];
		if (aboveC <= SATURATED_DEPRESSION_C) return belowM + (belowC - SATURATED_DEPRESSION_C) / (belowC - aboveC) * (aboveM - belowM);
	}
	return null;
}
function boundaryLayerDepth(surfaceTemperatureC, modelElevationM, levels) {
	for (let index = 0; index < levels.length; index += 1) {
		const level = levels[index];
		const altitudeAglM = level.heightM - modelElevationM;
		if (surfaceTemperatureC - altitudeAglM * DRY_ADIABATIC_LAPSE_C_PER_M > level.temperatureC) continue;
		if (index === 0) return Math.max(0, altitudeAglM);
		const previous = levels[index - 1];
		const previousAglM = previous.heightM - modelElevationM;
		const lapse = (level.temperatureC - previous.temperatureC) / (level.heightM - previous.heightM);
		const denominator = DRY_ADIABATIC_LAPSE_C_PER_M + lapse;
		if (Math.abs(denominator) < 1e-5) return Math.max(0, previousAglM);
		return Math.max(0, (surfaceTemperatureC - previous.temperatureC + lapse * previousAglM) / denominator);
	}
	if (levels.length > 0) return Math.max(0, levels[levels.length - 1].heightM - modelElevationM);
	return 0;
}
function thermalVelocity(surfaceTemperatureC, sensibleHeatFluxWm2, latentHeatFluxWm2, boundaryLayerDepthM, firstPressureHpa) {
	if (boundaryLayerDepthM <= 0 || firstPressureHpa === null) return 0;
	const surfaceTemperatureK = surfaceTemperatureC + 273.15;
	const virtualHeatFlux = sensibleHeatFluxWm2 + 245268e-9 * surfaceTemperatureK * latentHeatFluxWm2;
	if (virtualHeatFlux <= 0) return 0;
	const potentialTemperatureK = surfaceTemperatureK * (1015 / firstPressureHpa) ** .28482;
	return Math.cbrt(.0075516 / potentialTemperatureK * virtualHeatFlux * boundaryLayerDepthM);
}
function clampAltitude(value, minimum) {
	return Number.isFinite(value) ? Math.max(minimum, value) : minimum;
}
function clamp(value, minimum, maximum) {
	return Math.min(maximum, Math.max(minimum, value));
}
//#endregion
export { deriveSiteForecast };
