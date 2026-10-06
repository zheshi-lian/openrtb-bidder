# 消费者混淆规则：保留对外回调与实体，避免媒体侧混淆后崩溃
-keep public class com.zhuque.adsdk.** { public *; }
-keepclassmembers class com.zhuque.adsdk.** { public static ** Companion; }
-keepattributes *Annotation*, InnerClasses, Signature
