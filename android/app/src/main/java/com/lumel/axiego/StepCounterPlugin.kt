package com.lumel.axiego

import android.Manifest
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorManager
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * JS-facing bridge for the background step counter. See StepCounterService
 * for the actual sensor + foreground-service + notification logic, and
 * HealthConnectSync for the optional Health Connect integration — this class
 * is deliberately thin, just translating between PluginCall/JSObject and
 * those two.
 */
@CapacitorPlugin(
    name = "StepCounter",
    permissions = [
        Permission(strings = [Manifest.permission.ACTIVITY_RECOGNITION], alias = "activity"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")
    ]
)
class StepCounterPlugin : Plugin(), StepCounterBus.Listener {

    private val scope = CoroutineScope(Dispatchers.Main + Job())

    override fun load() {
        super.load()
        StepCounterBus.subscribe(this)
    }

    override fun handleOnDestroy() {
        StepCounterBus.unsubscribe(this)
        scope.cancel()
        super.handleOnDestroy()
    }

    override fun onSteps(steps: Int) {
        val data = JSObject()
        data.put("steps", steps)
        notifyListeners("stepsUpdated", data)
    }

    @PluginMethod
    fun isSupported(call: PluginCall) {
        val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val hasSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null
        val ret = JSObject()
        ret.put("supported", hasSensor)
        call.resolve(ret)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (getPermissionState("activity") != PermissionState.GRANTED) {
            call.reject("Physical activity permission not granted")
            return
        }
        StepCounterStore.setTrackingEnabled(context, true)
        ContextCompat.startForegroundService(context, Intent(context, StepCounterService::class.java))
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        StepCounterStore.setTrackingEnabled(context, false)
        context.stopService(Intent(context, StepCounterService::class.java))
        call.resolve()
    }

    @PluginMethod
    fun getTodaySteps(call: PluginCall) {
        val steps = StepCounterStore.getStepsToday(context)
        val ret = JSObject()
        ret.put("steps", steps)
        ret.put("distanceKm", steps * 0.78 / 1000.0)
        ret.put("tracking", StepCounterStore.isTrackingEnabled(context))
        call.resolve(ret)
    }

    @PluginMethod
    fun isHealthConnectAvailable(call: PluginCall) {
        val ret = JSObject()
        ret.put("available", HealthConnectSync.isAvailable(context))
        call.resolve(ret)
    }

    @PluginMethod
    fun requestHealthConnectPermissions(call: PluginCall) {
        if (!HealthConnectSync.isAvailable(context)) {
            call.reject("Health Connect is not installed on this device")
            return
        }
        scope.launch {
            if (HealthConnectSync.hasPermissions(context)) {
                val ret = JSObject()
                ret.put("granted", true)
                ret.put("grantedRead", true)
                ret.put("grantedWrite", true)
                call.resolve(ret)
                return@launch
            }
            try {
                val intent = HealthConnectSync.buildPermissionIntent(context)
                startActivityForResult(call, intent, "handleHealthConnectPermissionResult")
            } catch (e: Exception) {
                // If Health Connect itself has never been opened/set up on this
                // phone (or the OS otherwise can't resolve its permission
                // screen), the Activity launch can fail immediately instead of
                // showing any UI — which previously looked identical to a
                // normal "not granted" response. Surface it distinctly so it's
                // obvious this isn't a user decline.
                call.reject("Could not open Health Connect's permission screen — try opening the Health Connect app itself first: ${e.message}")
            }
        }
    }

    @ActivityCallback
    fun handleHealthConnectPermissionResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        // Health Connect's consent-screen result Intent is not always a
        // reliable source of truth for what actually got granted (a known
        // rough edge across OEM/Health-Connect versions) — after the
        // Activity returns, re-check the LIVE permission state directly via
        // PermissionController instead of trusting parsePermissionResult()
        // alone. That live check is what every other method in
        // HealthConnectSync already uses, so this makes the just-requested
        // result consistent with what the rest of the app will see a moment
        // later anyway.
        scope.launch {
            val parsed = HealthConnectSync.parsePermissionResult(result.resultCode, result.data)
            val live = HealthConnectSync.grantedPermissionsPublic(context)
            val granted = if (live.isNotEmpty()) live else parsed
            val ret = JSObject()
            ret.put("granted", granted.containsAll(HealthConnectSync.permissions))
            ret.put("grantedRead", granted.contains(HealthConnectSync.readPermission))
            ret.put("grantedWrite", granted.contains(HealthConnectSync.writePermission))
            // Diagnostic fields only — safe to ignore, but let the JS side
            // surface exactly what happened without needing device logs.
            ret.put("resultCode", result.resultCode)
            ret.put("parsedCount", parsed.size)
            ret.put("liveCount", live.size)
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun getHealthConnectTodaySteps(call: PluginCall) {
        if (!HealthConnectSync.isAvailable(context)) {
            call.reject("Health Connect is not installed on this device")
            return
        }
        scope.launch {
            val total = HealthConnectSync.readTodayTotal(context)
            val ret = JSObject()
            if (total != null) ret.put("steps", total)
            call.resolve(ret)
        }
    }
}
