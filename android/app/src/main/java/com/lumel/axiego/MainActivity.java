package com.lumel.axiego;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StepCounterPlugin.class);
        registerPlugin(LocationTrackingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
