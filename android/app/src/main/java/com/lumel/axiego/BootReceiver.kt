package com.lumel.axiego

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * Restarts step counting after the phone reboots, but only if the user had
 * already turned background tracking on — a reboot should never silently
 * turn a feature on that wasn't already agreed to.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!StepCounterStore.isTrackingEnabled(context)) return
        ContextCompat.startForegroundService(context, Intent(context, StepCounterService::class.java))
    }
}
