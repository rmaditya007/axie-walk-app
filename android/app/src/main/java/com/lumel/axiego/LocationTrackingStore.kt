package com.lumel.axiego

import android.content.Context
import android.content.SharedPreferences

/**
 * All persisted state for a GO-session's native GPS tracking lives here —
 * one SharedPreferences file shared between LocationTrackingService (which
 * owns the actual location subscription and does the distance/steps/$bAXS
 * accounting) and LocationTrackingPlugin (which JS talks to). Mirrors
 * StepCounterStore's role for the step counter, and mirrors main.js's own
 * haversine/plausibility-filter math (see applyFix below) so the numbers a
 * native-tracked session produces match what the same session would have
 * produced from the old in-WebView tracker. Nothing here ever leaves the
 * device.
 */
object LocationTrackingStore {
    private const val PREFS = "axiego_location_tracking"
    private const val KEY_ACTIVE = "active"
    private const val KEY_PAUSED = "paused"
    private const val KEY_MODE = "mode"
    private const val KEY_DISTANCE_M_BITS = "distance_m_bits"
    private const val KEY_ACCUM_ELAPSED_MS = "accum_elapsed_ms"
    private const val KEY_RUNNING_SINCE_MS = "running_since_ms" // -1 when paused/stopped
    private const val KEY_LAST_LAT_BITS = "last_lat_bits"
    private const val KEY_LAST_LNG_BITS = "last_lng_bits"
    private const val KEY_LAST_FIX_AT_MS = "last_fix_at_ms"
    private const val KEY_HAS_LAST_FIX = "has_last_fix"

    // Mirrors src/main.js's STRIDE_M / BAXS_PER_STEP / MIN_ACCURACY_M /
    // MAX_PLAUSIBLE_SPEED_MPS exactly, so a session tracked natively (while
    // locked) and one tracked in the WebView (while open) earn the same way.
    const val STRIDE_M = 0.78
    const val BAXS_PER_STEP = 0.1 / 1000.0
    const val MIN_ACCURACY_M = 35f
    const val MAX_PLAUSIBLE_SPEED_MPS = 8.0 // ~28.8 km/h — beyond this, treat as a GPS jump and discard

    data class Snapshot(
        val active: Boolean,
        val paused: Boolean,
        val mode: String,
        val distanceKm: Double,
        val steps: Int,
        val baxs: Double,
        val elapsedSec: Int
    )

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun putDouble(editor: SharedPreferences.Editor, key: String, value: Double) {
        editor.putLong(key, java.lang.Double.doubleToRawLongBits(value))
    }

    private fun getDouble(p: SharedPreferences, key: String, default: Double): Double {
        if (!p.contains(key)) return default
        return java.lang.Double.longBitsToDouble(p.getLong(key, 0L))
    }

    @Synchronized
    fun startSession(context: Context, mode: String) {
        prefs(context).edit().also { e ->
            e.putBoolean(KEY_ACTIVE, true)
            e.putBoolean(KEY_PAUSED, false)
            e.putString(KEY_MODE, mode)
            putDouble(e, KEY_DISTANCE_M_BITS, 0.0)
            e.putLong(KEY_ACCUM_ELAPSED_MS, 0L)
            e.putLong(KEY_RUNNING_SINCE_MS, System.currentTimeMillis())
            e.putBoolean(KEY_HAS_LAST_FIX, false)
        }.apply()
    }

    @Synchronized
    fun pauseSession(context: Context) {
        val p = prefs(context)
        if (!p.getBoolean(KEY_ACTIVE, false) || p.getBoolean(KEY_PAUSED, false)) return
        val runningSince = p.getLong(KEY_RUNNING_SINCE_MS, -1L)
        val accum = p.getLong(KEY_ACCUM_ELAPSED_MS, 0L) +
            (if (runningSince > 0) System.currentTimeMillis() - runningSince else 0L)
        p.edit()
            .putBoolean(KEY_PAUSED, true)
            .putLong(KEY_ACCUM_ELAPSED_MS, accum)
            .putLong(KEY_RUNNING_SINCE_MS, -1L)
            // Avoids one large jump-distance segment being counted across
            // the pause gap once tracking resumes — same reason main.js
            // clears its own lastFix on pause.
            .putBoolean(KEY_HAS_LAST_FIX, false)
            .apply()
    }

    @Synchronized
    fun resumeSession(context: Context) {
        val p = prefs(context)
        if (!p.getBoolean(KEY_ACTIVE, false)) return
        p.edit()
            .putBoolean(KEY_PAUSED, false)
            .putLong(KEY_RUNNING_SINCE_MS, System.currentTimeMillis())
            .apply()
    }

    /** Ends the session, clears active state, and returns its final snapshot. */
    @Synchronized
    fun stopSession(context: Context): Snapshot {
        val snap = snapshot(context)
        prefs(context).edit()
            .putBoolean(KEY_ACTIVE, false)
            .putBoolean(KEY_PAUSED, false)
            .putLong(KEY_RUNNING_SINCE_MS, -1L)
            .putBoolean(KEY_HAS_LAST_FIX, false)
            .apply()
        return snap
    }

    fun isActive(context: Context): Boolean = prefs(context).getBoolean(KEY_ACTIVE, false)
    fun isPaused(context: Context): Boolean = prefs(context).getBoolean(KEY_PAUSED, false)
    fun getMode(context: Context): String = prefs(context).getString(KEY_MODE, "walk") ?: "walk"

    fun elapsedSec(context: Context): Int {
        val p = prefs(context)
        val runningSince = p.getLong(KEY_RUNNING_SINCE_MS, -1L)
        val accum = p.getLong(KEY_ACCUM_ELAPSED_MS, 0L) +
            (if (runningSince > 0) System.currentTimeMillis() - runningSince else 0L)
        return (accum / 1000L).toInt()
    }

    fun snapshot(context: Context): Snapshot {
        val p = prefs(context)
        val distanceKm = getDouble(p, KEY_DISTANCE_M_BITS, 0.0) / 1000.0
        val steps = distanceKm * 1000.0 / STRIDE_M
        val baxs = steps * BAXS_PER_STEP
        return Snapshot(
            active = p.getBoolean(KEY_ACTIVE, false),
            paused = p.getBoolean(KEY_PAUSED, false),
            mode = p.getString(KEY_MODE, "walk") ?: "walk",
            distanceKm = distanceKm,
            steps = steps.toInt(),
            baxs = baxs,
            elapsedSec = elapsedSec(context)
        )
    }

    /**
     * Applies one location fix: computes the Haversine distance from the
     * last accepted fix (if any) and, when it passes the same
     * accuracy/speed plausibility filters main.js's own applyFix() uses,
     * adds it to the session total. Returns null when there's no active,
     * unpaused session to apply it to (a fix that arrived after stop, or
     * during a pause race) — the caller should simply drop it in that case.
     */
    @Synchronized
    fun applyFix(context: Context, lat: Double, lng: Double, accuracy: Float?, tsMs: Long): Snapshot? {
        val p = prefs(context)
        if (!p.getBoolean(KEY_ACTIVE, false) || p.getBoolean(KEY_PAUSED, false)) return null

        val e = p.edit()
        if (p.getBoolean(KEY_HAS_LAST_FIX, false)) {
            val lastLat = getDouble(p, KEY_LAST_LAT_BITS, lat)
            val lastLng = getDouble(p, KEY_LAST_LNG_BITS, lng)
            val lastAtMs = p.getLong(KEY_LAST_FIX_AT_MS, tsMs)
            val dtSec = maxOf(0.001, (tsMs - lastAtMs) / 1000.0)
            val distM = haversineMeters(lastLat, lastLng, lat, lng)
            val speed = distM / dtSec
            val goodAccuracy = accuracy == null || accuracy <= MIN_ACCURACY_M
            val plausible = speed <= MAX_PLAUSIBLE_SPEED_MPS
            if (goodAccuracy && plausible && distM > 0) {
                val newDistanceM = getDouble(p, KEY_DISTANCE_M_BITS, 0.0) + distM
                putDouble(e, KEY_DISTANCE_M_BITS, newDistanceM)
            }
        }
        putDouble(e, KEY_LAST_LAT_BITS, lat)
        putDouble(e, KEY_LAST_LNG_BITS, lng)
        e.putLong(KEY_LAST_FIX_AT_MS, tsMs)
        e.putBoolean(KEY_HAS_LAST_FIX, true)
        e.apply()
        return snapshot(context)
    }

    private fun haversineMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = 6371000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val la1 = Math.toRadians(lat1)
        val la2 = Math.toRadians(lat2)
        val sinDLat = Math.sin(dLat / 2)
        val sinDLng = Math.sin(dLng / 2)
        val h = sinDLat * sinDLat + Math.cos(la1) * Math.cos(la2) * sinDLng * sinDLng
        return 2 * r * Math.asin(Math.min(1.0, Math.sqrt(h)))
    }
}
