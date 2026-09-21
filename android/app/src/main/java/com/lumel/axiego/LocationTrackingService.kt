package com.lumel.axiego

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import java.util.Locale

/**
 * Runs a GO session's GPS tracking as a foreground service — the same
 * pattern StepCounterService already uses for steps — so a walk/run keeps
 * recording distance and time, and this service's own notification keeps
 * showing live status, even after the phone locks. A plain
 * navigator.geolocation.watchPosition() call from the WebView (the old
 * approach) can't survive that: locking the screen eventually throttles or
 * suspends WebView JS since there's no foreground service holding the app
 * "awake." A foreground service that has called startForeground() is
 * treated as a foreground app for location-access purposes, so this needs
 * no separate "allow location all the time" background permission — just
 * the same ACCESS_FINE_LOCATION prompt the map already asks for.
 *
 * All the actual accounting (distance/steps/$bAXS/elapsed, with the same
 * accuracy/speed plausibility filters main.js's own tracker uses) lives in
 * LocationTrackingStore, so it's correct and query-able even from process
 * restarts. This service is just the thing that owns the live location
 * subscription and keeps the notification fresh.
 */
class LocationTrackingService : Service() {

    companion object {
        const val CHANNEL_ID = "axiego_location"
        const val NOTIF_ID = 4202
        const val EXTRA_MODE = "mode"
        const val ACTION_START = "com.lumel.axiego.action.START_LOCATION"
        const val ACTION_PAUSE = "com.lumel.axiego.action.PAUSE_LOCATION"
        const val ACTION_RESUME = "com.lumel.axiego.action.RESUME_LOCATION"
        private const val MIN_TIME_MS = 2000L
        private const val MIN_DISTANCE_M = 2f
        private const val TICK_INTERVAL_MS = 20000L // keeps the notification's elapsed time fresh even between fixes
    }

    private var locationManager: LocationManager? = null
    private val tickHandler = Handler(Looper.getMainLooper())

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) = handleLocation(location)
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    private val tickRunnable = object : Runnable {
        override fun run() {
            if (LocationTrackingStore.isActive(applicationContext)) {
                updateNotification(LocationTrackingStore.snapshot(applicationContext))
                tickHandler.postDelayed(this, TICK_INTERVAL_MS)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        locationManager = getSystemService(LOCATION_SERVICE) as? LocationManager

        val snap = LocationTrackingStore.snapshot(applicationContext)
        val notification = buildNotification(snap)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, notification)
        }

        if (snap.active && !snap.paused) startLocationUpdates()
        tickHandler.postDelayed(tickRunnable, TICK_INTERVAL_MS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PAUSE -> {
                stopLocationUpdates()
                updateNotification(LocationTrackingStore.snapshot(applicationContext))
            }
            ACTION_RESUME -> {
                startLocationUpdates()
                updateNotification(LocationTrackingStore.snapshot(applicationContext))
            }
            else -> {
                // Fresh session start (or the OS redelivering the sticky
                // intent after restarting a killed process) — the store
                // already has the right active/paused state by the time
                // this ever runs, so just make sure we're actually
                // listening if we should be.
                if (LocationTrackingStore.isActive(applicationContext) && !LocationTrackingStore.isPaused(applicationContext)) {
                    startLocationUpdates()
                }
            }
        }
        return START_STICKY
    }

    private fun handleLocation(location: Location) {
        val accuracy = if (location.hasAccuracy()) location.accuracy else null
        val tsMs = if (location.time > 0) location.time else System.currentTimeMillis()
        val snap = LocationTrackingStore.applyFix(applicationContext, location.latitude, location.longitude, accuracy, tsMs)
            ?: return // session was paused/stopped out from under this fix — nothing to do
        updateNotification(snap)
        LocationTrackingBus.publish(
            LocationTrackingBus.Update(
                lat = location.latitude,
                lng = location.longitude,
                accuracy = accuracy,
                tsMs = tsMs,
                distanceKm = snap.distanceKm,
                steps = snap.steps,
                baxs = snap.baxs,
                elapsedSec = snap.elapsedSec,
                mode = snap.mode
            )
        )
    }

    private fun startLocationUpdates() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            // LocationTrackingPlugin already gates start() on this permission
            // being granted before it ever launches this service — this is
            // just a defensive no-op if it was somehow revoked mid-session.
            return
        }
        val lm = locationManager ?: return
        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, MIN_TIME_MS, MIN_DISTANCE_M, locationListener, mainLooper)
            }
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, MIN_TIME_MS, MIN_DISTANCE_M, locationListener, mainLooper)
            }
        } catch (e: SecurityException) {
            // Permission revoked out from under us — nothing more to do.
        }
    }

    private fun stopLocationUpdates() {
        locationManager?.removeUpdates(locationListener)
    }

    private fun createChannel() {
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(CHANNEL_ID, "Walk & run tracking", NotificationManager.IMPORTANCE_LOW)
            channel.description = "Live distance and time for your current Axie GO walk or run, kept up to date even with the screen locked."
            channel.setShowBadge(false)
            mgr.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(snap: LocationTrackingStore.Snapshot): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = launchIntent?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val modeLabel = if (snap.mode == "run") "Run" else "Walk"
        val statusLabel = if (snap.paused) "Paused" else "In progress"
        val title = String.format(Locale.US, "%s · %s", modeLabel, statusLabel)
        val body = String.format(
            Locale.US,
            "%.2f km · %s · %,d steps · keeps tracking if your phone locks",
            snap.distanceKm, fmtElapsed(snap.elapsedSec), snap.steps
        )
        // setSmallIcon needs a flat single-color stencil, not the app's full
        // adaptive launcher icon — see drawable/ic_stat_notify.xml for why.
        val largeIcon = IconUtil.largeIcon(this)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setLargeIcon(largeIcon)
            .setContentTitle(title)
            .setContentText(body)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun updateNotification(snap: LocationTrackingStore.Snapshot) {
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIF_ID, buildNotification(snap))
    }

    private fun fmtElapsed(sec: Int): String {
        val m = sec / 60
        val s = sec % 60
        return String.format(Locale.US, "%02d:%02d", m, s)
    }

    override fun onDestroy() {
        stopLocationUpdates()
        tickHandler.removeCallbacks(tickRunnable)
        super.onDestroy()
    }
}
