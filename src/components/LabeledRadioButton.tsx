import React, { FunctionComponent } from "react";
import { Text, View } from "react-native";
import { RadioButton } from "react-native-paper";
import { Colors, Message, MessageLocalizationParam } from "../constants";

type LabeledRadioButtonProps = {
    value: string;
    label: MessageLocalizationParam;
};
export const LabeledRadioButton: FunctionComponent<LabeledRadioButtonProps> = (
    props: LabeledRadioButtonProps
) => {
    return (
        <View
            style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center"
            }}
        >
            <RadioButton
                value={props.value}
                color={Colors.cyan}
                uncheckedColor={Colors.cyan}
            />
            <Text style={{ color: Colors.white }}>
                {Message.get(props.label)}
            </Text>
        </View>
    );
};