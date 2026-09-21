package com.lumel.axiego

import android.Manifest
import android.content.Context
import android.content.Intent
import android.location.LocationManager
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission

/**
 * JS-facing bridge for GO-session GPS tracking. See LocationTrackingService
 * for the actual location subscription + foreground-service + notification
 * logic, and LocationTrackingStore for the distance/steps/$bAXS accounting
 * — this class is deliberately thin, mirroring StepCounterPlugin's shape:
 * just translating between PluginCall/JSObject and those two.
 *
 * Capacitor auto-generates checkPermissions()/requestPermissions() from the
 * `permissions` annotation below (same as StepCounterPlugin relies on for
 * its "activity" alias) — main.js's requestPermissions() call gets back
 * { location: "granted" | "denied" | "prompt" }.
 */
@CapacitorPlugin(
    name = "LocationTracking",
    permissions = [
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION], alias = "location")
    ]
)
class LocationTrackingPlugin : Plugin(), LocationTrackingBus.Listener {

    override fun load() {
        super.load()
        LocationTrackingBus.subscribe(this)
    }

    override fun handleOnDestroy() {
        LocationTrackingBus.unsubscribe(this)
        super.handleOnDestroy()
    }

    override fun onUpdate(update: LocationTrackingBus.Update) {
        val data = JSObject()
        data.put("lat", update.lat)
        data.put("lng", update.lng)
        if (update.accuracy != null) data.put("accuracy", update.accuracy)
        data.put("tsMs", update.tsMs)
        data.put("distanceKm", update.distanceKm)
        data.put("steps", update.steps)
        data.put("baxs", update.baxs)
        data.put("elapsedSec", update.elapsedSec)
        data.put("mode", update.mode)
        notifyListeners("locationUpdated", data)
    }

    @PluginMethod
    fun isSupported(call: PluginCall) {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        val ret = JSObject()
        ret.put("supported", lm != null)
        call.resolve(ret)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Location permission not granted")
            return
        }
        val mode = call.getString("mode") ?: "walk"
        LocationTrackingStore.startSession(context, mode)
        val intent = Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_START
            putExtra(LocationTrackingService.EXTRA_MODE, mode)
        }
        ContextCompat.startForegroundService(context, intent)
        call.resolve()
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        LocationTrackingStore.pauseSession(context)
        context.startService(Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_PAUSE
        })
        call.resolve()
    }

    @PluginMethod
    fun resume(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Location permission not granted")
            return
        }
        LocationTrackingStore.resumeSession(context)
        context.startService(Intent(context, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_RESUME
        })
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val snap = LocationTrackingStore.stopSession(context)
        context.stopService(Intent(context, LocationTrackingService::class.java))
        val ret = JSObject()
        ret.put("distanceKm", snap.distanceKm)
        ret.put("steps", snap.steps)
        ret.put("baxs", snap.baxs)
        ret.put("elapsedSec", snap.elapsedSec)
        ret.put("mode", snap.mode)
        call.resolve(ret)
    }

    @PluginMethod
    fun getSessionSnapshot(call: PluginCall) {
        val snap = LocationTrackingStore.snapshot(context)
        val ret = JSObject()
        ret.put("active", snap.active)
        ret.put("paused", snap.paused)
        ret.put("mode", snap.mode)
        ret.put("distanceKm", snap.distanceKm)
        ret.put("steps", snap.steps)
        ret.put("baxs", snap.baxs)
        ret.put("elapsedSec", snap.elapsedSec)
        call.resolve(ret)
    }
}
