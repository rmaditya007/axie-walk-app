package com.lumel.axiego

/**
 * In-process pub/sub so StepCounterService (running as a foreground service)
 * can push live step updates straight to StepCounterPlugin while the app is
 * open, without the overhead/deprecation baggage of LocalBroadcastManager —
 * the service and the app's UI always share one process here, so a plain
 * in-memory listener set is all that's needed.
 */
object StepCounterBus {
    fun interface Listener {
        fun onSteps(steps: Int)
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
    fun publish(steps: Int) {
        listeners.forEach { it.onSteps(steps) }
    }
}
