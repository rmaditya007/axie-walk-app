package com.lumel.axiego

/**
 * In-process pub/sub so LocationTrackingService (running as a foreground
 * service) can push live GO-session updates straight to
 * LocationTrackingPlugin while the app is open — mirrors StepCounterBus for
 * the same reason: the service and the app's UI always share one process
 * here, so a plain in-memory listener set is all that's needed. Nothing
 * delivered through here is authoritative on its own — LocationTrackingStore
 * is — this is just the live-push channel for whichever fixes happen to
 * land while the WebView is actually alive to receive them.
 */
object LocationTrackingBus {
    data class Update(
        val lat: Double,
        val lng: Double,
        val accuracy: Float?,
        val tsMs: Long,
        val distanceKm: Double,
        val steps: Int,
        val baxs: Double,
        val elapsedSec: Int,
        val mode: String
    )

    fun interface Listener {
        fun onUpdate(update: Update)
    }

    private val listeners = mutableSetOf<Listener>()

    @Synchronized
    fun subscribe(listener: Listener) {
        listeners.add(listener)
    }

    @Synchronized
    fun unsubscribe(listener: Listener) {
        listeners.remove(listener)
    }

    @Synchronized
    fun publish(update: Update) {
        listeners.forEach { it.onUpdate(update) }
    }
}
