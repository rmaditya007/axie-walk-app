package com.lumel.axiego

import android.content.Context
import android.content.SharedPreferences
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * All persisted state for the background step counter lives here, in one
 * SharedPreferences file shared between StepCounterService (which owns the
 * sensor), BootReceiver, and StepCounterPlugin (which JS talks to). Nothing
 * here ever leaves the device — there is no server, no account, no upload
 * except the optional, explicit Health Connect sync.
 */
object StepCounterStore {
    private const val PREFS = "axiego_step_counter"
    private const val KEY_DATE = "date"
    private const val KEY_STEPS_TODAY = "steps_today"
    private const val KEY_LAST_TOTAL = "last_total_since_boot"
    private const val KEY_TRACKING_ENABLED = "tracking_enabled"
    private const val KEY_LAST_HC_SYNCED_STEPS = "last_hc_synced_steps"
    private const val KEY_HC_SEEDED_DATE = "hc_seeded_date"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun todayKey(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

    fun isTrackingEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_TRACKING_ENABLED, false)

    fun setTrackingEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_TRACKING_ENABLED, enabled).apply()
    }

    fun getStepsToday(context: Context): Int {
        val p = prefs(context)
        val storedDate = p.getString(KEY_DATE, null)
        return if (storedDate == todayKey()) p.getInt(KEY_STEPS_TODAY, 0) else 0
    }

    /**
     * Applies one TYPE_STEP_COUNTER reading (a running total-since-last-reboot)
     * and returns the updated steps-today count. Robust to two edge cases that
     * a naive "subtract a fixed baseline" approach gets wrong: the sensor
     * resets to 0 on every device reboot, and the day can roll over while the
     * app (and even the service) is asleep.
     */
    @Synchronized
    fun applyTotalSinceBoot(context: Context, totalSinceBoot: Int): Int {
        val p = prefs(context)
        val today = todayKey()
        val storedDate = p.getString(KEY_DATE, null)
        val lastTotal = p.getInt(KEY_LAST_TOTAL, -1)
        var stepsToday = if (storedDate == today) p.getInt(KEY_STEPS_TODAY, 0) else 0

        if (lastTotal >= 0 && totalSinceBoot >= lastTotal && storedDate == today) {
            stepsToday += (totalSinceBoot - lastTotal)
        }
        // Otherwise this is the very first reading, a reboot (the counter fell
        // back below what we last saw), or a new day — in each case there is
        // no correct delta for this one tick, so we just resync the running
        // baseline here and keep counting forward from it.

        p.edit()
            .putString(KEY_DATE, today)
            .putInt(KEY_STEPS_TODAY, stepsToday)
            .putInt(KEY_LAST_TOTAL, totalSinceBoot)
            .apply()
        return stepsToday
    }

    /**
     * Credits steps already recorded today by OTHER sources (Google Fit,
     * Samsung Health, any app that writes to Health Connect) — the exact gap
     * a bare hardware-sensor baseline can never fill in on its own, since
     * that sensor only ever reports steps taken *after* this service starts
     * listening. Takes the higher of what we've already counted ourselves
     * and Health Connect's today-total, so it only ever moves the count up,
     * never overwrites a higher number this device's own sensor already
     * recorded. Runs at most once per calendar day (idempotent — safe to
     * call every time the service starts) so it never re-adds the same
     * Health Connect total on top of itself. Returns true if it changed
     * anything worth re-publishing to the UI/notification.
     */
    @Synchronized
    fun seedTodayFromHealthConnect(context: Context, healthConnectTotal: Int): Boolean {
        val p = prefs(context)
        val today = todayKey()
        if (p.getString(KEY_HC_SEEDED_DATE, null) == today) return false
        val storedDate = p.getString(KEY_DATE, null)
        val currentSteps = if (storedDate == today) p.getInt(KEY_STEPS_TODAY, 0) else 0
        val newSteps = maxOf(currentSteps, healthConnectTotal)
        p.edit()
            .putString(KEY_DATE, today)
            .putInt(KEY_STEPS_TODAY, newSteps)
            .putString(KEY_HC_SEEDED_DATE, today)
            .apply()
        return newSteps != currentSteps
    }

    fun getLastHealthConnectSyncedSteps(context: Context): Int =
        prefs(context).getInt(KEY_LAST_HC_SYNCED_STEPS, 0)

    fun setLastHealthConnectSyncedSteps(context: Context, steps: Int) {
        prefs(context).edit().putInt(KEY_LAST_HC_SYNCED_STEPS, steps).apply()
    }
}
