package com.lumel.axiego

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Runs as a foreground service (required by Android to keep a background
 * service alive reliably, and to keep the persistent notification visible)
 * and listens to the phone's own TYPE_STEP_COUNTER hardware sensor. This
 * keeps counting whether Axie GO is open, backgrounded, or fully closed —
 * the same pattern every pedometer/fitness app on Android uses. It does NOT
 * use GPS and does NOT itself award $bAXS; it only tracks and displays a
 * step count. $bAXS is still earned only through an explicit GO session in
 * the app (see main.js) — see the README for why that stays a deliberate,
 * separate mechanic.
 *
 * Honest limitation: some phone manufacturers (Xiaomi/MIUI, Samsung, Huawei,
 * OnePlus and others) apply their own aggressive battery-optimization on top
 * of stock Android and can still kill foreground services despite the
 * ongoing notification and START_STICKY. If steps stop counting after a
 * while, the fix is on the OS side: disable battery optimization for Axie GO
 * in the phone's own battery/app settings (README has exact steps per OEM
 * where known).
 */
class StepCounterService : Service(), SensorEventListener {

    companion object {
        const val CHANNEL_ID = "axiego_steps"
        const val NOTIF_ID = 4201
        private const val STRIDE_M = 0.78
        private const val HEALTH_CONNECT_SYNC_THRESHOLD = 25
    }

    private var sensorManager: SensorManager? = null
    private var stepSensor: Sensor? = null
    private val scope = CoroutineScope(Dispatchers.Default + Job())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()

        val initialSteps = StepCounterStore.getStepsToday(applicationContext)
        val notification = buildNotification(initialSteps)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
        } else {
            startForeground(NOTIF_ID, notification)
        }

        sensorManager = getSystemService(SENSOR_SERVICE) as? SensorManager
        stepSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        if (stepSensor == null) {
            // This device doesn't expose a hardware step-counter sensor at
            // all — nothing we can do here, so stop rather than sit idle
            // with a notification that will never update.
            stopSelf()
            return
        }
        sensorManager?.registerListener(this, stepSensor, SensorManager.SENSOR_DELAY_NORMAL)

        // Credit steps already taken today via other sources (Google Fit,
        // Samsung Health, any other app that writes to Health Connect)
        // before this service ever started — otherwise a fresh install (or
        // just a phone reboot before the first tap of "Turn on") always
        // starts today's count at 0 and quietly drops everything walked
        // earlier that day. Only runs once per calendar day (see
        // StepCounterStore.seedTodayFromHealthConnect) and only has
        // anything to pull from once the user has connected Health Connect
        // at least once — see HealthConnectSync.
        scope.launch {
            val hcTotal = HealthConnectSync.readTodayTotal(applicationContext)
            if (hcTotal != null && hcTotal > 0) {
                val updated = StepCounterStore.seedTodayFromHealthConnect(applicationContext, hcTotal.toInt())
                if (updated) {
                    val steps = StepCounterStore.getStepsToday(applicationContext)
                    updateNotification(steps)
                    StepCounterBus.publish(steps)
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_STEP_COUNTER) return
        val totalSinceBoot = event.values[0].toInt()
        val stepsToday = StepCounterStore.applyTotalSinceBoot(applicationContext, totalSinceBoot)
        updateNotification(stepsToday)
        StepCounterBus.publish(stepsToday)
        maybeSyncHealthConnect(stepsToday)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun maybeSyncHealthConnect(stepsToday: Int) {
        val lastSynced = StepCounterStore.getLastHealthConnectSyncedSteps(applicationContext)
        val delta = stepsToday - lastSynced
        if (delta < HEALTH_CONNECT_SYNC_THRESHOLD) return // batch writes, don't hammer Health Connect every step
        scope.launch {
            val ok = HealthConnectSync.writeStepsDelta(applicationContext, delta)
            if (ok) {
                StepCounterStore.setLastHealthConnectSyncedSteps(applicationContext, stepsToday)
            }
        }
    }

    private fun createChannel() {
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(CHANNEL_ID, "Daily steps", NotificationManager.IMPORTANCE_LOW)
            channel.description = "Your Axie GO step count for today, kept up to date in the background."
            channel.setShowBadge(false)
            mgr.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(stepsToday: Int): Notification {
        val km = stepsToday * STRIDE_M / 1000.0
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = launchIntent?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val stepsText = String.format(Locale.US, "%,d steps today", stepsToday)
        val subText = String.format(Locale.US, "%.2f km · open Axie GO to earn from a walk or run", km)
        // setSmallIcon needs a flat single-color stencil, not the app's full
        // adaptive launcher icon — see drawable/ic_stat_notify.xml for why.
        // The branded, full-color Axie GO icon shows via setLargeIcon
        // instead — that's the thumbnail visible when the notification
        // shade is pulled down or expanded. See IconUtil for why that can't
        // just be BitmapFactory.decodeResource().
        val largeIcon = IconUtil.largeIcon(this)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setLargeIcon(largeIcon)
            .setContentTitle(stepsText)
            .setContentText(subText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun updateNotification(stepsToday: Int) {
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIF_ID, buildNotification(stepsToday))
    }

    override fun onDestroy() {
        sensorManager?.unregisterListener(this)
        scope.cancel()
        super.onDestroy()
    }
}
