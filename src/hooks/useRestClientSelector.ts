import { useSelector } from "react-redux";

import { RootState } from "../state";
import { AuroraRestClient } from "../clients";

const clientSelector = (state: RootState): AuroraRestClient =>
    state.core.restClient;

export const useRestClientSelector = (): AuroraRestClient => {
    return useSelector(clientSelector);
};