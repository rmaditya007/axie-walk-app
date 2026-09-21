package com.lumel.axiego

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView

/**
 * Health Connect links to this from its own permission screen ("why does
 * this app want my data?"). Kept intentionally simple: a plain-text
 * explanation, no network calls, no analytics — matching what the app
 * actually does with step data (counts it locally, and only reaches Health
 * Connect at all if you explicitly tap "Sync with Health Connect").
 */
class PermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = TextView(this)
        text.text = "Axie GO reads your step count to show it in the app and in a " +
            "background notification, and — only if you turn this on — writes your " +
            "step count to Health Connect so other apps can see it too. Step data " +
            "never leaves your device except through that explicit Health Connect sync. " +
            "There is no ad tracking and no data sale."
        text.textSize = 16f
        text.setTextColor(Color.BLACK)
        text.gravity = Gravity.START
        val pad = (resources.displayMetrics.density * 24).toInt()
        text.setPadding(pad, pad, pad, pad)
        setContentView(text)
    }
}
