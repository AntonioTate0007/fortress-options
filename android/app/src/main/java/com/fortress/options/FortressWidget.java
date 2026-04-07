package com.fortress.options;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * FortressWidget — Home screen widget for Fortress Options.
 *
 * Reads the top play from SharedPreferences (key: "fortress_top_play").
 * The main app (JavaScript side via Capacitor Preferences) writes this key
 * whenever it fetches fresh plays from the API.
 *
 * Expected JSON format stored under "fortress_top_play":
 *   {"symbol":"SPY","score":8}
 */
public class FortressWidget extends AppWidgetProvider {

    /** SharedPreferences file name — must match what the JS side writes to. */
    private static final String PREFS_NAME = "CapacitorStorage";

    /** Key inside SharedPreferences that holds the top play JSON. */
    private static final String KEY_TOP_PLAY = "fortress_top_play";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId);
        }
    }

    /** Build and push a single widget view. */
    static void updateWidget(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.fortress_widget);

        // --- Read SharedPreferences ---
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String json = prefs.getString(KEY_TOP_PLAY, null);

        String symbol = null;
        int score = -1;

        if (json != null) {
            try {
                JSONObject obj = new JSONObject(json);
                symbol = obj.optString("symbol", null);
                score  = obj.optInt("score", -1);
            } catch (Exception e) {
                // malformed JSON — fall through to "no data" state
            }
        }

        if (symbol != null && !symbol.isEmpty()) {
            // We have real data — populate all fields
            views.setTextViewText(R.id.widget_symbol, symbol);
            views.setTextViewText(R.id.widget_score,  "Score: " + score + "/10");

            String badge = (score >= 8) ? "🔥 HOT" : "⚡ PLAY";
            views.setTextViewText(R.id.widget_badge, badge);
        } else {
            // No data yet — show friendly placeholder
            views.setTextViewText(R.id.widget_symbol, "—");
            views.setTextViewText(R.id.widget_score,  "No plays yet");
            views.setTextViewText(R.id.widget_badge,  "⚡ PLAY");
        }

        // --- Tap anywhere → open app ---
        Intent launchIntent = new Intent(context, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(context, appWidgetId, launchIntent, flags);

        views.setOnClickPendingIntent(R.id.widget_root, pendingIntent);

        appWidgetManager.updateAppWidget(appWidgetId, views);
    }
}
