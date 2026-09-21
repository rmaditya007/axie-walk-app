package com.lumel.axiego

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.core.content.ContextCompat

/**
 * Rasterizes the app's launcher icon into a plain Bitmap for use as a
 * notification's large icon.
 *
 * BitmapFactory.decodeResource() can only decode a real raster image
 * (PNG/JPG/WebP) baked directly into the APK. On API 26+, @mipmap/ic_launcher
 * resolves through mipmap-anydpi-v26/ic_launcher.xml — an <adaptive-icon>,
 * which is not a raster resource at all — so BitmapFactory silently returns
 * null for it on every modern phone. That's why the notification never
 * actually showed the branded icon even after the app's launcher art was
 * updated: setLargeIcon(null) is a no-op. Going through Resources'
 * getDrawable() and drawing onto a Canvas instead handles an adaptive icon,
 * a vector drawable, or a plain bitmap uniformly.
 */
object IconUtil {
    fun largeIcon(context: Context): Bitmap? {
        val drawable = ContextCompat.getDrawable(context, R.mipmap.ic_launcher) ?: return null
        val w = drawable.intrinsicWidth.takeIf { it > 0 } ?: 192
        val h = drawable.intrinsicHeight.takeIf { it > 0 } ?: 192
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        drawable.setBounds(0, 0, canvas.width, canvas.height)
        drawable.draw(canvas)
        return bmp
    }
}
