package com.fortress.options;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin so the JS side can force the home screen widget to redraw
 * the moment a new top play is written to SharedPreferences. Without this the
 * widget would only refresh on the system's 30-minute updatePeriodMillis timer
 * and would silently lag behind incoming plays.
 */
@CapacitorPlugin(name = "WidgetUpdater")
public class WidgetUpdaterPlugin extends Plugin {

    @PluginMethod
    public void refresh(PluginCall call) {
        Context ctx = getContext();
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, FortressWidget.class));
        for (int id : ids) {
            FortressWidget.updateWidget(ctx, mgr, id);
        }
        call.resolve();
    }
}
