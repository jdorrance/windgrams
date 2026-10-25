/** Temperatures °C; pressure hPa; geometric height metres MSL. */
export interface ThermodynamicLevel { heightM: number; pressureHpa: number; temperatureC: number; dewPointC?: number | null; dewPointDepressionC?: number | null }
export interface PressureLevel { pressureHpa?: number | null; heightM?: number | null; temperatureC?: number | null }
/** Meteorological direction: degrees clockwise from true north, where wind comes from. */
export interface Wind { windSpeedMps?: number | null; windDirectionDeg?: number | null }
export interface WindLevel extends Wind { heightM: number }
export interface SurfaceWind extends Wind { wind80mSpeedMps?: number | null; wind80mDirectionDeg?: number | null }
export interface BoundaryLayerWind {
  blMeanWindSpeedMps: number; blMeanWindDirDeg: number;
  blTopWindSpeedMps: number; blTopWindDirDeg: number; blWindShearMps: number;
}
