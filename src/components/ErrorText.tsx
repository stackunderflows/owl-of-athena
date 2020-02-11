import React, { FunctionComponent } from "react";
import { StyleSheet, Text, TextStyle } from "react-native";

import { Colors, Dimens, Fonts, MessageLocalizationParam } from "../constants";

type ErrorTextProps = {
    children: MessageLocalizationParam;
    style?: TextStyle;
};
export const ErrorText: FunctionComponent<ErrorTextProps> = (
    props: ErrorTextProps
) => {
    return <Text style={createTextStyle(props.style)}>{props.children}</Text>;
};
const textStyle: TextStyle = {
    color: Colors.red,
    fontFamily: Fonts.primaryRegular,
    fontSize: Dimens.error_text_size,
    marginBottom: Dimens.error_text_margin_bottom
};
function createTextStyle(propsStyle?: TextStyle) {
    return StyleSheet.flatten([propsStyle, textStyle]);
}
